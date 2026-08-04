// 전량 이벤트 인덱스 — 3층 복원 구조 (2026-08-04 재설계):
//   ① 부팅: 저널(관측된 이벤트의 디스크 원장) 리플레이
//   ② 부팅: 온체인 객체에서 현재 상태 재구성 (저널 공백 보충)
//   ③ 운영: 체크포인트 테일링으로 증분 유지 + 관측 즉시 저널 append
// 게이트 판정·수익 집계는 전부 이 인메모리 상태를 읽는다 (요청당 RPC 0회).
//
// 왜 queryEvents가 아닌가: 풀노드가 2에폭 이전 tx/이벤트를 프루닝하는데
// 이벤트 인덱스 엔트리는 남아서, 프루닝 구간을 스치는 모든 queryEvents가
// 페이지째 에러난다 (2026-07-29 전면 장애의 원인). 체크포인트 테일링은 tip
// 근처만 읽으므로 면역이고, 커서가 단일 정수라 영속화도 단순하다.
import { client } from './client.mjs'
import { PKG, FEED } from './config.mjs'
import { loadJournal, appendJournal, loadCursor, saveCursor } from './journal.mjs'
import { readChainState } from './bootstrap.mjs'

const EVENT_TYPES = [
  'feed::PostCreated',
  'paid_posts::PaywallCreated',
  'paid_posts::PostPurchased',
  'subscriptions::TierCreated',
  'subscriptions::Subscribed',
  'tips::TipSent',
  'creator_prefs::PrefsChanged',
]

const seen = new Set() // `${txDigest}:${eventSeq}` — 주입·폴링·리플레이 중복 제거
// dedupe가 실제로 필요한 창은 "자기 tx 동기 주입 ~ 폴링 커서가 그 이벤트를 지나갈
// 때까지"(수 초)뿐. 커서가 지나간 이벤트는 다시 오지 않으므로, 상한 초과 시
// 오래된 키를 잘라도 안전하다.
const SEEN_MAX = 50_000
// 이벤트 리플레이와 객체 재구성이 같은 포스트를 두 번 넣지 않게 하는 2차 키
const knownPosts = new Set()

// 저널 리플레이·객체 재구성 중엔 append 금지 (리플레이분은 이미 저널에 있고,
// 재구성 산물은 매 부팅 체인에서 다시 만들 수 있다) — 초기화 완료 후 개방
let journaling = false

// 인덱스 상태 버전 — 이벤트가 실제 반영될 때마다 증가 (파생 뷰 캐시 무효화용)
let version = 0
export const stateVersion = () => version

export const state = {
  posts: [], // PostCreated (시간 오름차순): {parsedJson, timestampMs, txDigest}
  paywallByPost: new Map(), // post_id → PaywallCreated parsedJson
  tierInfo: new Map(), // tier id → TierCreated parsedJson
  subExpiry: new Map(), // `${tier}:${subscriber}` → 최신 만료시각(연장은 최댓값이 진실)
  purchased: new Set(), // `${post_id}:${buyer}`
  prefsByCreator: new Map(), // creator → {locked, previews} (마지막 이벤트가 승리)
  // Subscribed/TipSent/PostPurchased 원장 — 소스가 뒤섞일 수 있으므로
  // 소비자는 반드시 timestampMs로 정렬할 것
  earnings: [],
}

function apply(shortType, ev, fallbackTs) {
  const p = ev.parsedJson
  const timestampMs = Number(ev.timestampMs ?? fallbackTs)
  switch (shortType) {
    case 'feed::PostCreated': {
      const pid = String(p.post_id)
      if (knownPosts.has(pid)) break
      knownPosts.add(pid)
      state.posts.push({ parsedJson: p, timestampMs, txDigest: ev.id.txDigest })
      break
    }
    case 'paid_posts::PaywallCreated':
      state.paywallByPost.set(String(p.post_id), p)
      break
    case 'subscriptions::TierCreated':
      state.tierInfo.set(p.tier, p)
      break
    case 'subscriptions::Subscribed': {
      const k = `${p.tier}:${p.subscriber}`
      if (Number(p.expires_ms) > (state.subExpiry.get(k) || 0))
        state.subExpiry.set(k, Number(p.expires_ms))
      break
    }
    case 'paid_posts::PostPurchased':
      state.purchased.add(`${p.post_id}:${p.buyer}`)
      break
    case 'creator_prefs::PrefsChanged':
      // 오름차순 처리라 마지막 쓰기 = 최신 설정
      state.prefsByCreator.set(p.creator, {
        locked: !!p.profile_locked,
        previews: !!p.show_locked_previews,
      })
      break
  }
  if (
    shortType === 'subscriptions::Subscribed' ||
    shortType === 'tips::TipSent' ||
    shortType === 'paid_posts::PostPurchased'
  ) {
    state.earnings.push({ shortType, parsedJson: p, timestampMs, txDigest: ev.id.txDigest })
  }
}

export function ingestEvents(events, fallbackTs = Date.now()) {
  for (const ev of events ?? []) {
    if (!ev?.type?.startsWith(`${PKG}::`)) continue
    const shortType = ev.type.slice(PKG.length + 2)
    if (!EVENT_TYPES.includes(shortType)) continue
    const key = `${ev.id.txDigest}:${ev.id.eventSeq}`
    if (seen.has(key)) continue
    seen.add(key)
    if (seen.size > SEEN_MAX) {
      for (const k of seen) {
        seen.delete(k)
        if (seen.size <= SEEN_MAX / 2) break
      }
    }
    if (journaling)
      appendJournal({
        id: ev.id,
        type: ev.type,
        parsedJson: ev.parsedJson,
        timestampMs: Number(ev.timestampMs ?? fallbackTs),
      })
    apply(shortType, ev, fallbackTs)
    version++
  }
}

// 객체 재구성 병합 — 이벤트 리플레이가 이미 채운 항목은 건드리지 않고 공백만
// 메운다. 구매·구독 원장은 집합/최댓값이라 순서 무관, prefs는 현재 객체 값이
// 곧 최신이므로 덮어쓴다. earnings는 합성하지 않는다 — 금액·시각을 지어내지
// 않고, 과거 이력은 아카이브 리플레이로만 소급한다.
function mergeChainState(cs) {
  for (const t of cs.tiers) {
    if (!state.tierInfo.has(t.tier))
      state.tierInfo.set(t.tier, {
        tier: t.tier,
        creator: t.creator,
        price: t.price,
        period_ms: t.period_ms,
      })
    for (const s of t.subs) {
      const k = `${t.tier}:${s.subscriber}`
      if (s.expires_ms > (state.subExpiry.get(k) || 0)) state.subExpiry.set(k, s.expires_ms)
    }
  }
  for (const pw of cs.paywalls) {
    if (!state.paywallByPost.has(pw.post_id))
      state.paywallByPost.set(pw.post_id, {
        paywall: pw.paywall,
        feed: FEED,
        post_id: pw.post_id,
        price: pw.price,
      })
    for (const b of pw.purchases) state.purchased.add(`${pw.post_id}:${b.buyer}`)
  }
  for (const pr of cs.prefs)
    state.prefsByCreator.set(pr.creator, {
      locked: pr.profile_locked,
      previews: pr.show_locked_previews,
    })
  for (const post of cs.posts) {
    if (post.deleted || knownPosts.has(post.seq)) continue
    knownPosts.add(post.seq)
    state.posts.push({
      parsedJson: {
        feed: FEED,
        post_id: post.seq,
        author: post.author,
        content_uri: post.content_uri,
        root: post.root,
        replied_to: post.replied_to,
        quoted: post.quoted,
        reposted: post.reposted,
      },
      timestampMs: post.created_ms,
      // 원본 tx가 프루닝돼 digest를 알 수 없다 — fakeCid 입력용 안정 식별자
      txDigest: `chain-object-post-${post.seq}`,
    })
  }
  state.posts.sort((a, b) => a.timestampMs - b.timestampMs)
  version++
}

// ---- 체크포인트 테일링 ----

let ckpt = null // 마지막 처리한 체크포인트 시퀀스
let bootstrapAddresses = []

async function catchUp() {
  const latest = Number(await client.getLatestCheckpointSequenceNumber())
  while (ckpt < latest) {
    let page
    try {
      page = await client.getCheckpoints({
        cursor: String(ckpt),
        limit: 100,
        descendingOrder: false,
      })
    } catch (e) {
      // 커서 체크포인트가 프루닝됨(2에폭 이상 다운타임) — 그 구간 이벤트는 이
      // 노드에서 복구 불가. 게이트 상태는 객체 재구성으로 현재값을 되찾고 tip으로
      // 점프한다. 갭 구간의 수익 "이력"만 아카이브에 남는 공백.
      if (!/not found|could not find|pruned/i.test(String(e?.message))) throw e
      console.warn(
        `   ⚠️ 체크포인트 ${ckpt} 프루닝됨 — 객체 재구성 후 ${latest}로 점프 (갭 이력은 S3 아카이브에만 존재)`,
      )
      mergeChainState(await readChainState(bootstrapAddresses))
      ckpt = latest
      saveCursor(ckpt)
      return
    }
    if (!page.data.length) break
    const tsOf = new Map()
    for (const cp of page.data)
      for (const d of cp.transactions) tsOf.set(d, Number(cp.timestampMs))
    const digests = [...tsOf.keys()]
    for (let i = 0; i < digests.length; i += 50) {
      const chunk = digests.slice(i, i + 50)
      const txs = await client.multiGetTransactionBlocks({
        digests: chunk,
        options: { showEvents: true },
      })
      for (const tx of txs ?? []) {
        if (tx?.events?.length) ingestEvents(tx.events, Number(tx.timestampMs ?? tsOf.get(tx.digest)))
      }
    }
    ckpt = Number(page.data[page.data.length - 1].sequenceNumber)
    saveCursor(ckpt)
  }
}

// 부팅 초기화: 저널 리플레이 → 객체 재구성 → 저장 커서부터 tip까지 따라잡기.
// 부분 실패 후 재호출해도 안전하다 (리플레이는 seen으로, 재구성은 knownPosts와
// 집합 병합으로 멱등).
export async function initIndex(addresses) {
  bootstrapAddresses = addresses
  for (const ev of loadJournal()) ingestEvents([ev], ev.timestampMs)
  // 재구성 직전 tip을 커서 기본값으로 잡아 "객체 읽기~테일링 시작" 사이의
  // 이벤트가 새지 않게 한다 (겹침은 dedupe가 정리)
  const tip = Number(await client.getLatestCheckpointSequenceNumber())
  mergeChainState(await readChainState(addresses))
  ckpt = loadCursor() ?? tip
  journaling = true
  await catchUp()
}

let polling = false
export function startPolling(intervalMs = 1500) {
  setInterval(async () => {
    if (polling) return // 재진입 방지 (폴링이 인터벌보다 느릴 때)
    polling = true
    try {
      await catchUp()
    } catch {
      // 체인 일시 불통은 다음 틱에 재시도 — 커서가 있어 유실 없음
    } finally {
      polling = false
    }
  }, intervalMs).unref?.()
}

// ---- 파생 뷰 (기존 loadGateState 반환 구조와 동일한 표면) ----
export function gateView() {
  const { paywallByPost, tierInfo, subExpiry, purchased, prefsByCreator } = state
  const isSubscribedTo = (viewerAddr, creatorAddr) => {
    const now = Date.now()
    for (const [tier, t] of tierInfo) {
      if (t.creator === creatorAddr && (subExpiry.get(`${tier}:${viewerAddr}`) || 0) > now)
        return true
    }
    return false
  }
  const tierByCreator = new Map()
  for (const [id, t] of tierInfo) {
    if (!tierByCreator.has(t.creator)) {
      tierByCreator.set(t.creator, {
        id,
        priceGeunhwa: Number(t.price),
        periodMs: Number(t.period_ms),
      })
    }
  }
  const prefsOf = addr => prefsByCreator.get(addr) || { locked: false, previews: true }
  return { paywallByPost, isSubscribedTo, purchased, tierInfo, subExpiry, tierByCreator, prefsOf }
}

export const stats = () =>
  `posts=${state.posts.length} tiers=${state.tierInfo.size} subs=${state.subExpiry.size} ` +
  `paywalls=${state.paywallByPost.size} purchases=${state.purchased.size} events=${version}`
