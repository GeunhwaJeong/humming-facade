// 커서 기반 전량 이벤트 인덱스 — "최근 50건" 스캔의 정확성 결함을 종결한다.
// 부팅 시 타입별 커서를 제네시스부터 hasNextPage=false까지 따라가 전량 백필,
// 이후 ①자기 tx 이벤트 동기 주입(chain.execTx) ②주기 폴링으로 증분 유지.
// 게이트 판정·수익 집계는 전부 이 인메모리 상태를 읽는다 (요청당 RPC 0회).
import { client } from './chain.mjs'
import { PKG } from './config.mjs'

const EVENT_TYPES = [
  'feed::PostCreated',
  'paid_posts::PaywallCreated',
  'paid_posts::PostPurchased',
  'subscriptions::TierCreated',
  'subscriptions::Subscribed',
  'tips::TipSent',
  'creator_prefs::PrefsChanged',
]

// 검증용으로 페이지 크기를 줄여 다페이지 백필을 강제할 수 있음
const PAGE_LIMIT = Math.max(1, Number(process.env.INDEXER_PAGE_LIMIT) || 50)

const seen = new Set() // `${txDigest}:${eventSeq}` — 주입·폴링 중복 제거
const cursors = new Map() // fullType → nextCursor

export const state = {
  posts: [], // PostCreated (시간 오름차순): {parsedJson, timestampMs, txDigest}
  paywallByPost: new Map(), // post_id → PaywallCreated parsedJson
  tierInfo: new Map(), // tier id → TierCreated parsedJson
  subExpiry: new Map(), // `${tier}:${subscriber}` → 최신 만료시각(연장은 최댓값이 진실)
  purchased: new Set(), // `${post_id}:${buyer}`
  prefsByCreator: new Map(), // creator → {locked, previews} (마지막 이벤트가 승리)
  earnings: [], // Subscribed/TipSent/PostPurchased 원장 (시간 오름차순)
}

function apply(shortType, ev, fallbackTs) {
  const p = ev.parsedJson
  const timestampMs = Number(ev.timestampMs ?? fallbackTs)
  switch (shortType) {
    case 'feed::PostCreated':
      state.posts.push({ parsedJson: p, timestampMs, txDigest: ev.id.txDigest })
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
    const key = `${ev.id.txDigest}:${ev.id.eventSeq}`
    if (seen.has(key)) continue
    seen.add(key)
    apply(shortType, ev, fallbackTs)
  }
}

async function backfillType(shortType) {
  const type = `${PKG}::${shortType}`
  let cursor = cursors.get(type) ?? null
  for (;;) {
    const page = await client.queryEvents({
      query: { MoveEventType: type },
      cursor,
      limit: PAGE_LIMIT,
      order: 'ascending',
    })
    ingestEvents(page.data)
    if (page.nextCursor) cursor = page.nextCursor
    cursors.set(type, cursor)
    if (!page.hasNextPage) return
  }
}

// 타입별 저장 커서부터 최신까지 따라잡기 — 부팅 백필과 증분 폴링이 같은 코드
export async function backfill() {
  await Promise.all(EVENT_TYPES.map(backfillType))
}

let polling = false
export function startPolling(intervalMs = 1500) {
  setInterval(async () => {
    if (polling) return // 재진입 방지 (폴링이 인터벌보다 느릴 때)
    polling = true
    try {
      await backfill()
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
  `paywalls=${state.paywallByPost.size} purchases=${state.purchased.size} events=${seen.size}`
