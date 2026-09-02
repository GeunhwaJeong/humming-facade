// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

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

// keys: 문자열 하나 또는 [{key, windowMs}] 배열. 배열이면 어느 키로든 캐시·인플라이트가
// 잡히고(키마다 자기 창으로 판정), 등록은 전 키에 건다. 같은 논리 요청이 한 번은
// 헤더 없이, 한 번은 헤더와 함께 오는 경우가 두 tx로 갈라지는 창을 닫는다.
export async function idempotent(keys, windowMs, fn) {
  const entries = (Array.isArray(keys) ? keys : [{ key: keys, windowMs }]).map(e =>
    typeof e === 'string' ? { key: e, windowMs } : e,
  )
  for (const { key, windowMs: w } of entries) {
    const hit = recent.get(key)
    if (hit && Date.now() - hit.at < Math.min(w ?? windowMs, MAX_WINDOW_MS)) return hit.value
  }
  for (const { key } of entries) {
    const running = inflight.get(key)
    if (running) return running
  }
  const p = (async () => fn())()
    .then(value => {
      const at = Date.now()
      for (const { key } of entries) recent.set(key, { at, value })
      if (!sweepTimer) {
        sweepTimer = setInterval(sweep, SWEEP_MS)
        sweepTimer.unref?.()
      }
      return value
    })
    .finally(() => {
      for (const { key } of entries) inflight.delete(key)
    })
  for (const { key } of entries) inflight.set(key, p)
  return p
}

// 클라이언트가 Idempotency-Key 헤더를 보내면 그 키(창 10분)를 함께 등록한다.
// 유도 키(사용자, 연산, 대상)는 항상 등록·확인한다: 헤더 유무가 갈려도 같은
// 논리 요청은 같은 유도 키에서 만나 동시에 두 번 실행되지 않는다.
// contextKey는 영속 pending 기록(pending.mjs)의 키로도 쓰는 안정 식별자다.
export function idempotencyKeyFor(req, viewerDid, nsid, derived) {
  const keys = [{ key: derived.key, windowMs: derived.windowMs }]
  const header = req.headers['idempotency-key']
  if (typeof header === 'string' && header && header.length <= 128) {
    keys.push({ key: `hdr|${viewerDid}|${nsid}|${header}`, windowMs: MAX_WINDOW_MS })
  }
  return { keys, windowMs: derived.windowMs, contextKey: derived.key }
}
