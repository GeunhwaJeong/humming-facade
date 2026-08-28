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
//
// 테일링 전송은 gRPC다: 운영 중엔 SubscribeCheckpoints 스트림(순서 보장·갭
// 없음)으로 밀려오는 체크포인트를 받고, 재시작·스트림 단절 뒤의 공백은
// GetCheckpoint(read_mask로 이벤트만)로 메운다. 폴링과 "전 체인 tx 통째
// 다운로드"가 둘 다 사라지고, 퍼블릭 JSON-RPC 폐기 이후에도 살아남는다.
import { PKG, FEED } from './config.mjs'
import {
  checkpointToEvents, getCheckpointEvents, serviceInfo, subscribeCheckpoints, isUnavailable,
} from './grpc.mjs'
import { loadJournal, appendJournal, loadCursor, saveCursor } from './journal.mjs'
import { readChainState } from './bootstrap.mjs'

const EVENT_TYPES = [
  'feed::PostCreated',
  'feed::PostDeleted',
  'paid_posts::PaywallCreated',
  'paid_posts::PostPurchased',
  'subscriptions::TierCreated',
  'subscriptions::Subscribed',
  'tips::TipSent',
  'creator_prefs::PrefsChanged',
]

const seen = new Set() // `${txDigest}:${eventSeq}` — 주입·테일링·리플레이 중복 제거
// dedupe가 실제로 필요한 창은 "자기 tx 동기 주입 ~ 테일링 커서가 그 이벤트를 지나갈
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
  // 삭제된 post_id — posts 배열은 append-only로 두고(저널 리플레이·dedupe 단순성), 읽기가
  // 이 집합으로 거른다. 객체 재구성도 deleted 플래그를 여기 합친다
  deletedPosts: new Set(),
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
    case 'feed::PostDeleted':
      state.deletedPosts.add(String(p.post_id))
      break
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
    // parsedJson 없는 이벤트는 반영하면 인덱스가 깨진다(수익 집계가 amount를 읽음).
    // seen에 넣지 않고 건너뛰어, 같은 이벤트의 온전한 사본이 나중에 오면 반영되게 한다.
    if (ev.parsedJson == null) {
      console.warn(`   ⚠️ parsedJson 없는 이벤트 무시: ${ev.type} (${ev.id.txDigest}:${ev.id.eventSeq})`)
      continue
    }
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
    // 객체의 deleted가 진실 — 저널에 PostCreated만 있고 PostDeleted가 빠졌어도 여기서 잡힌다
    if (post.deleted) state.deletedPosts.add(post.seq)
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
// 객체 재구성에 쓸 계정 주소들. 함수를 받으면 호출 시점에 평가한다:
// pruneRecover가 부팅 이후의 런타임 가입 주소까지 포함해 재구성하게 한다
// (배열 고정이면 다운타임 복구 때 새 가입자의 티어·구독이 통째로 빠진다)
let bootstrapAddresses = []
const currentAddresses = () =>
  typeof bootstrapAddresses === 'function' ? bootstrapAddresses() : bootstrapAddresses

// 커서 영속화 스로틀 — 스트림은 체크포인트를 초당 수 개씩 밀어주므로 매 건
// fsync하면 디스크만 닳는다. 이벤트를 실제로 반영한 직후엔 즉시 저장해 저널
// 중복 리플레이 창을 좁히고, 그 외엔 주기적으로만 저장한다. 커서가 뒤처진 채
// 죽어도 재기동 시 같은 구간을 다시 읽을 뿐이고 dedupe가 이중 반영을 막는다.
const CURSOR_SAVE_MS = 5000
let cursorSavedAt = 0
// 마지막으로 체크포인트를 전진시킨 시각. /health가 테일링 랙 판정에 쓴다:
// 체크포인트는 평시 초 단위로 오므로 침묵이 길면 인덱스가 낡아지고 있는 것이다.
let lastCheckpointAt = null
export const tailingHealth = () => ({
  lastCheckpointAt,
  lagSeconds:
    lastCheckpointAt == null ? null : Math.round((Date.now() - lastCheckpointAt) / 1000),
})
function maybeSaveCursor(force = false) {
  const now = Date.now()
  if (!force && now - cursorSavedAt < CURSOR_SAVE_MS) return
  cursorSavedAt = now
  saveCursor(ckpt)
}

// 프루닝 하한 밑으로 떨어진 커서(2에폭 이상 다운타임)의 복구 — 그 구간 이벤트는
// 이 노드에서 복구 불가. 게이트 상태는 객체 재구성으로 현재값을 되찾고 tip으로
// 점프한다. 갭 구간의 수익 "이력"만 아카이브에 남는 공백.
async function pruneRecover(latest) {
  console.warn(
    `   ⚠️ 체크포인트 ${ckpt} 프루닝됨 — 객체 재구성 후 ${latest}로 점프 (갭 이력은 S3 아카이브에만 존재)`,
  )
  mergeChainState(await readChainState(currentAddresses()))
  ckpt = latest
  lastCheckpointAt = Date.now()
  maybeSaveCursor(true)
}

// 커서 다음부터 target(기본: 현재 tip)까지 순서대로 따라잡기.
// 이벤트만 read_mask로 받으므로 비용이 "체크포인트 수 × 이벤트량"이지
// 전 체인 tx 페이로드가 아니다. 조회는 병렬, 반영은 체크포인트 오름차순.
const CATCHUP_CONCURRENCY = 8

async function catchUp(target = null) {
  const info = await serviceInfo()
  const latest = target ?? Number(info.checkpointHeight)
  if (ckpt >= latest) return
  if (ckpt + 1 < Number(info.lowestAvailableCheckpoint ?? 0)) return pruneRecover(latest)
  while (ckpt < latest) {
    const seqs = []
    for (let s = ckpt + 1; s <= Math.min(ckpt + CATCHUP_CONCURRENCY, latest); s++) seqs.push(s)
    let cps
    try {
      cps = await Promise.all(seqs.map(getCheckpointEvents))
    } catch (e) {
      // 하한 검사와 조회 사이에 프루닝이 진행된 희귀 경합
      if (!isUnavailable(e)) throw e
      return pruneRecover(latest)
    }
    let ingested = false
    for (const cp of cps) {
      const { events, timestampMs } = checkpointToEvents(cp)
      if (events.length) {
        ingestEvents(events, timestampMs)
        ingested = true
      }
    }
    ckpt = seqs[seqs.length - 1]
    lastCheckpointAt = Date.now()
    maybeSaveCursor(ingested)
  }
  maybeSaveCursor(true)
}

// 부팅 초기화: 저널 리플레이 → 객체 재구성 → 저장 커서부터 tip까지 따라잡기.
// 부분 실패 후 재호출해도 안전하다 (리플레이는 seen으로, 재구성은 knownPosts와
// 집합 병합으로 멱등).
export async function initIndex(addresses) {
  bootstrapAddresses = addresses
  for (const ev of loadJournal()) ingestEvents([ev], ev.timestampMs)
  // 재구성 직전 tip을 커서 기본값으로 잡아 "객체 읽기~테일링 시작" 사이의
  // 이벤트가 새지 않게 한다 (겹침은 dedupe가 정리)
  const tip = Number((await serviceInfo()).checkpointHeight)
  mergeChainState(await readChainState(currentAddresses()))
  ckpt = loadCursor() ?? tip
  journaling = true
  await catchUp()
}

// 운영 테일링: 구독 스트림 수신 → 단절 시 재접속(그 사이 공백은 catchUp).
// 체크포인트는 초당 수 개씩 끊김없이 오므로, 일정 시간 수신 침묵이면 스트림이
// 조용히 죽은 것으로 보고 워치독이 끊어 재접속을 강제한다.
const STREAM_SILENCE_MS = 30_000
let stopped = false
let activeAc = null // 종료 시 열려 있는 스트림을 즉시 끊기 위한 핸들

// 우아한 종료용: 재접속 루프를 멈추고 열린 스트림을 끊는다. 커서 플러시는
// flushCursor가 별도로 수행한다 (여기서 하면 abort 경합 중 이중 저장).
export function stopTailing() {
  stopped = true
  activeAc?.abort()
}

export function flushCursor() {
  if (ckpt != null) maybeSaveCursor(true)
}

export function startTailing() {
  ;(async () => {
    let backoffMs = 1000
    while (!stopped) {
      const ac = new AbortController()
      activeAc = ac
      let watchdog = null
      // 침묵 워치독은 스트림이 열린 뒤에만 돈다 — 구독 전 catchUp은 다운타임
      // 길이에 비례해 오래 걸릴 수 있는 정당한 작업이라 끊으면 안 된다
      const armWatchdog = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => ac.abort(), STREAM_SILENCE_MS)
        watchdog.unref?.()
      }
      try {
        await catchUp()
        const stream = subscribeCheckpoints(ac.signal)
        armWatchdog()
        for await (const resp of stream.responses) {
          armWatchdog()
          backoffMs = 1000
          const seq = Number(resp.cursor)
          if (seq <= ckpt) continue
          // 구독은 접속 시점의 tip부터 시작한다 — 커서와의 사이 공백을 먼저 채워
          // 오름차순 반영 순서를 지킨다 (스트림 응답은 그동안 버퍼링될 뿐 유실 없음)
          if (seq > ckpt + 1) await catchUp(seq - 1)
          // 스트림 체크포인트의 이벤트에는 type만 있고 json(→parsedJson)이 비어
          // 있다 — 노드의 구독 렌더러는 Move 값 JSON 렌더링을 하지 않는다
          // (GetCheckpoint 경로만 render_json_with_budget을 수행). 그래서 스트림은
          // 우리 패키지 이벤트의 "감지"에만 쓰고, 반영은 해당 체크포인트를
          // GetCheckpoint로 다시 읽어 수행한다. 조용한 체크포인트는 추가 호출 0회.
          const detected = checkpointToEvents(resp.checkpoint).events
          const relevant = detected.some(ev => ev.type?.startsWith(`${PKG}::`))
          if (relevant) {
            const { events, timestampMs } = checkpointToEvents(await getCheckpointEvents(seq))
            ingestEvents(events, timestampMs)
          }
          ckpt = seq
          lastCheckpointAt = Date.now()
          maybeSaveCursor(relevant)
        }
        // 스트림 정상 종료(노드 재시작 등) — 재접속
      } catch (e) {
        if (!stopped && !ac.signal.aborted)
          console.warn(`   ⚠️ 체크포인트 스트림 단절: ${e?.message ?? e} — ${backoffMs}ms 후 재접속`)
      } finally {
        clearTimeout(watchdog)
      }
      if (stopped) break
      await new Promise(r => {
        const t = setTimeout(r, backoffMs)
        t.unref?.()
      })
      backoffMs = Math.min(backoffMs * 2, 30_000)
    }
  })()
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
