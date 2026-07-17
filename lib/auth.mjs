// 인증 프리미티브 — JWT 실서명·검증 + 비밀번호 해싱. 외부 의존성 없이 node:crypto만 사용.
// 시크릿: HUMMING_JWT_SECRET env가 있으면 그걸 쓰고, 없으면 1회 생성해 0600 파일로 영속
// (재시작해도 발급된 세션이 살아있어야 함 — 인메모리 시크릿이면 재시작=전원 로그아웃).
import crypto from 'node:crypto'
import fs from 'node:fs'

const SECRET_FILE = new URL('../.jwt-secret', import.meta.url)
function loadSecret() {
  if (process.env.HUMMING_JWT_SECRET)
    return crypto.createHash('sha256').update(process.env.HUMMING_JWT_SECRET).digest()
  try {
    const b64 = fs.readFileSync(SECRET_FILE, 'utf8').trim()
    fs.chmodSync(SECRET_FILE, 0o600)
    const secret = Buffer.from(b64, 'base64')
    if (secret.length === 32) return secret
  } catch {}
  const secret = crypto.randomBytes(32)
  fs.writeFileSync(SECRET_FILE, secret.toString('base64') + '\n', { mode: 0o600 })
  fs.chmodSync(SECRET_FILE, 0o600)
  return secret
}
const SECRET = loadSecret()

export const ACCESS_TTL_S = 60 * 60 * 24 // 1일 — 만료 시 앱이 ExpiredToken을 보고 refresh
export const REFRESH_TTL_S = 60 * 60 * 24 * 90 // 90일 — 그 뒤엔 재로그인

const b64u = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url')
const timingSafeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b)

export function makeJwt(did, scope, ttlS) {
  const now = Math.floor(Date.now() / 1000)
  const body = [
    b64u({ typ: 'JWT', alg: 'HS256' }),
    b64u({ scope, sub: did, aud: 'did:web:localhost', iat: now, exp: now + ttlS }),
  ].join('.')
  return `${body}.${sign(body)}`
}

// access/refresh 쌍 발급 — createAccount/createSession/refreshSession 공용
export const sessionTokens = did => ({
  accessJwt: makeJwt(did, 'com.atproto.access', ACCESS_TTL_S),
  refreshJwt: makeJwt(did, 'com.atproto.refresh', REFRESH_TTL_S),
})

// 서명이 유효하면 payload를 반환, 아니면 null. 만료(exp) 판정은 호출자 몫 —
// 만료를 여기서 null로 뭉개면 앱의 refresh 트리거(ExpiredToken)를 구분할 수 없다.
export function verifyJwt(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  const expected = sign(`${parts[0]}.${parts[1]}`)
  if (!timingSafeEq(Buffer.from(parts[2]), Buffer.from(expected))) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    return payload && typeof payload.sub === 'string' ? payload : null
  } catch {
    return null
  }
}

// scrypt (N=16384, r=8, p=1) + 계정별 랜덤 솔트 — 디스크·메모리에 평문 비밀번호 금지.
// async: 시도당 ~50-100ms의 scrypt가 이벤트루프를 잡으면 로그인 폭주 = 전 유저 정지가 된다.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }
const scrypt = (pw, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, 32, SCRYPT_OPTS, (err, key) => (err ? reject(err) : resolve(key))),
  )
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(String(password), salt)
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`
}
export async function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false
  const hash = await scrypt(String(password), Buffer.from(saltB64, 'base64url'))
  return timingSafeEq(hash, Buffer.from(hashB64, 'base64url'))
}

// 미지 계정 로그인도 실존 계정과 같은 scrypt 비용을 치르게 하는 더미 검증 대상 —
// 응답 시간으로 계정 존재 여부를 구분할 수 없게 한다. 절대 매칭되지 않는 랜덤 값.
export const DUMMY_HASH = `scrypt$${crypto.randomBytes(16).toString('base64url')}$${crypto
  .randomBytes(32)
  .toString('base64url')}`
