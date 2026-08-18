// 결제 멱등성 — 같은 (사용자, 연산, 대상) 요청이 겹치거나 짧은 창 안에서 반복되면
// 새 온체인 트랜잭션을 만들지 않고 첫 요청의 결과를 그대로 돌려준다. 프론트의
// 이중발화 가드가 못 막는 경로(타임아웃 후 네트워크 재시도, 프록시 재전송,
// 다른 탭)를 서버에서 닫는 마지막 방벽이다.
//
// 규칙:
// - 진행 중(in-flight)인 동일 키 요청은 같은 프라미스를 공유한다 — 재시도가
//   두 번째 결제를 만들지 않고 첫 결제의 결과를 받는다.
// - 성공 결과는 windowMs 동안 캐시되어 지연 재시도에도 같은 응답을 준다.
// - 실패는 캐시하지 않는다 — 잔고 부족을 채우고 곧바로 다시 시도할 수 있어야 한다.
const inflight = new Map() // key → Promise
const recent = new Map() // key → { at, value }
let sweepTimer = null
const SWEEP_MS = 60_000
const MAX_WINDOW_MS = 10 * 60_000

function sweep() {
  const cutoff = Date.now() - MAX_WINDOW_MS
  for (const [k, v] of recent) if (v.at < cutoff) recent.delete(k)
  if (!recent.size && sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

export async function idempotent(key, windowMs, fn) {
  const hit = recent.get(key)
  if (hit && Date.now() - hit.at < Math.min(windowMs, MAX_WINDOW_MS)) return hit.value
  const running = inflight.get(key)
  if (running) return running
  const p = (async () => fn())()
    .then(value => {
      recent.set(key, { at: Date.now(), value })
      if (!sweepTimer) {
        sweepTimer = setInterval(sweep, SWEEP_MS)
        sweepTimer.unref?.()
      }
      return value
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, p)
  return p
}

// 클라이언트가 Idempotency-Key 헤더를 보내면 그것을 키로 쓴다(가장 정확).
// 없으면 (사용자, 연산, 대상)에서 유도한 키로 폴백.
export function idempotencyKeyFor(req, viewerDid, nsid, derived) {
  const header = req.headers['idempotency-key']
  if (typeof header === 'string' && header && header.length <= 128) {
    return { key: `hdr|${viewerDid}|${nsid}|${header}`, windowMs: MAX_WINDOW_MS }
  }
  return derived
}
