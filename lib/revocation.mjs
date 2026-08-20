// 세션 폐기 목록. JWT는 상태가 없어 발급 후에는 만료 전까지 유효한 것이 기본값이다:
// deleteSession(로그아웃)이 실제로 세션을 죽이려면 서버가 폐기 사실을 기억해야 한다.
// 발급 시 access/refresh 쌍에 공유 세션 ID(jti)를 심고, 폐기는 jti 단위로 한다.
// jti가 없는 구형 토큰은 토큰 해시로 폐기한다 (access는 하루면 자연 만료).
// 목록은 원자적으로 영속되어 재시작해도 로그아웃이 유지된다. 항목은 refresh 수명
// (90일)만큼 보관 후 청소된다: 그 뒤에는 어떤 토큰도 살아있지 않다.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { writeFileAtomic } from './atomic.mjs'
import { REFRESH_TTL_S } from './auth.mjs'
import { NETWORK } from './config.mjs'

const FILE = new URL(`../revoked-sessions.${NETWORK}.json`, import.meta.url)

const revoked = new Map() // id(jti 또는 토큰 해시) → 청소 가능 시각(epoch초)
try {
  for (const [id, exp] of Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))) {
    if (Number.isFinite(exp)) revoked.set(id, exp)
  }
} catch {} // 파일 부재(첫 부팅) 또는 손상: 빈 목록으로 시작해도 안전 축(세션 유지)으로만 틀린다

const persist = () =>
  writeFileAtomic(FILE, JSON.stringify(Object.fromEntries(revoked)), { mode: 0o600 })

const nowS = () => Math.floor(Date.now() / 1000)

function prune() {
  const now = nowS()
  for (const [id, exp] of revoked) if (exp <= now) revoked.delete(id)
}

// jti 없는 구형 토큰의 폐기 키. 원문 토큰을 디스크에 남기지 않기 위한 해시.
export const tokenId = token =>
  crypto.createHash('sha256').update(String(token)).digest('base64url')

// 세션 ID(또는 토큰 해시)를 폐기 목록에 올린다. 보관 기한은 refresh 수명과 동일:
// jti는 access/refresh가 공유하므로 access 만료(1일)를 기준으로 잡으면
// refresh 쪽이 되살아난다.
export function revokeSession(id) {
  prune()
  revoked.set(id, nowS() + REFRESH_TTL_S)
  persist()
}

export const isRevoked = id => (id ? revoked.has(id) : false)
