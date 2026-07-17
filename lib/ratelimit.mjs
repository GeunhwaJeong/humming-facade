// 고정 윈도 인메모리 레이트리미터 — 단일 프로세스 파사드 전제라 외부 저장소 불요.
// auth.mjs와 같은 원칙(node 내장만)으로 의존성 0. 초과 응답은 XRPC 에러 형태
// { error, message } — 앱의 기존 에러 토스트 경로가 그대로 렌더한다.
export function rateLimit({
  windowMs,
  max,
  key = req => req.ip,
  error = 'RateLimitExceeded',
  message = 'Too many requests — try again later',
}) {
  const hits = new Map() // key -> { count, resetAt }
  return (req, res, next) => {
    const k = key(req)
    if (k == null) return next() // 키를 만들 수 없는 요청(본문 없는 프리플라이트 등)은 통과
    const now = Date.now()
    let h = hits.get(k)
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + windowMs }
      hits.set(k, h)
    }
    if (++h.count > max) {
      res.setHeader('Retry-After', Math.ceil((h.resetAt - now) / 1000))
      return res.status(429).json({ error, message })
    }
    // 만료 키 청소는 맵이 커졌을 때만 — 평시 요청 경로에 O(n) 순회를 얹지 않는다
    if (hits.size > 10_000) {
      for (const [kk, hh] of hits) if (hh.resetAt <= now) hits.delete(kk)
    }
    next()
  }
}
