// 지갑 키 관리 — 파사드 소유 키 저장소(wallet-keys.json) + CLI 키스토어 1회 임포트.
// CLI 키스토어는 읽기 전용으로만 접근하고, 파사드가 아는 계정 주소의 키만 가져온다
// (파운더·운영 키는 절대 복사하지 않음). 신규 가입 키는 인프로세스 생성.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { Ed25519Keypair } from '@haneullabs/haneul/keypairs/ed25519'
import { writeFileAtomic } from './atomic.mjs'
import { noteChange } from './backup.mjs'
import { NETWORK } from './config.mjs'

// 네트워크별 파일 분리 — 로컬넷 regenesis 청소(rm wallet-keys.json)가 메인넷
// 수탁 키를 파괴하지 못하게 한다. 메인넷 파일은 절대 삭제 금지, 백업 대상.
const KEYS_FILE = new URL(
  NETWORK === 'mainnet' ? '../wallet-keys.mainnet.json' : '../wallet-keys.json',
  import.meta.url,
)
const CLI_KEYSTORE = `${process.env.HOME}/.haneul/haneul_config/haneul.keystore`

const keypairs = new Map() // address → Ed25519Keypair
let persisted = {} // address → bech32 haneulprivkey (wallet-keys.json 원본)

// ---- 저장 시 암호화 ----
// HUMMING_KEYS_PASSPHRASE가 설정되면 키 저장소를 scrypt(KDF) + AES-256-GCM 봉투로
// 암호화해 저장한다. 디스크/백업 사본이 유출되어도 패스프레이즈 없이는 키를 읽을 수
// 없다. 미설정이면 평문(로컬넷 개발 편의) — 프로덕션 posture는 부팅 가드가 설정을
// 강제한다. 기존 평문 파일은 패스프레이즈가 생긴 첫 부팅에서 자동 마이그레이션.
const PASSPHRASE = process.env.HUMMING_KEYS_PASSPHRASE || null
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
let derived = null // { salt: Buffer, key: Buffer } — 부팅당 1회 유도, persist마다 재사용

function deriveKey(salt, params = SCRYPT) {
  if (derived && derived.salt.equals(salt)) return derived.key
  const key = crypto.scryptSync(PASSPHRASE, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT.maxmem,
  })
  derived = { salt, key }
  return key
}

const isEnvelope = obj => obj != null && obj.v === 1 && typeof obj.data === 'string'

function encryptStore(plainObj) {
  const salt = derived?.salt ?? crypto.randomBytes(16)
  const key = deriveKey(salt)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(plainObj), 'utf8'), cipher.final()])
  return {
    v: 1,
    kdf: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function decryptStore(env) {
  if (!PASSPHRASE) {
    throw new Error(
      '지갑 키 저장소가 암호화되어 있는데 HUMMING_KEYS_PASSPHRASE가 설정되지 않았습니다.',
    )
  }
  const key = deriveKey(Buffer.from(env.salt, 'base64'), env)
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
  d.setAuthTag(Buffer.from(env.tag, 'base64'))
  try {
    return JSON.parse(
      Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).toString('utf8'),
    )
  } catch {
    // GCM 인증 실패 = 패스프레이즈 불일치 또는 파일 변조. 빈 저장소로 계속 부팅하면
    // 다음 persist가 암호화 원본을 덮어써 전 키를 파괴하므로 반드시 여기서 죽어야 한다.
    throw new Error(
      '지갑 키 저장소 복호화 실패 — HUMMING_KEYS_PASSPHRASE가 이 파일을 만든 값과 다릅니다.',
    )
  }
}

// 비밀키 파일은 소유자 전용(0600). 전 사용자 수탁 키의 단일 원본이므로 반드시
// 원자적으로 교체한다 — 쓰기 도중 크래시가 파일을 깨면 복구 수단이 없다.
const persist = () => {
  const body = PASSPHRASE ? encryptStore(persisted) : persisted
  writeFileAtomic(KEYS_FILE, JSON.stringify(body, null, 2), { mode: 0o600 })
  noteChange() // 새 키는 백업에도 실려야 원본이 된다 (디바운스 스냅샷)
}

export function loadKeys() {
  let raw = null
  // 파일 부재(첫 부팅)만 빈 저장소로 진행한다. 그 외의 실패(파싱 불능, 권한 오류
  // 등)는 손상된 키 저장소를 빈 상태로 착각한 채 부팅해 다음 persist가 원본을
  // 덮어쓰는 경로이므로 반드시 부팅을 중단한다 (복호화 실패는 decryptStore가 던짐).
  try {
    raw = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'))
    fs.chmodSync(KEYS_FILE, 0o600) // 과거 0644로 생성된 파일 교정
  } catch (e) {
    if (e.code !== 'ENOENT')
      throw new Error(`지갑 키 저장소를 읽을 수 없습니다 (손상 가능성): ${e.message}`)
    persisted = {}
  }
  if (raw != null) {
    if (isEnvelope(raw)) {
      persisted = decryptStore(raw) // 실패 시 throw — 부팅 중단이 정답
    } else {
      persisted = raw
      if (PASSPHRASE && Object.keys(persisted).length) {
        persist() // 평문 → 암호화 마이그레이션 (같은 경로에 원자적 교체)
        console.log(`🔐 지갑 키 저장소를 암호화 포맷(v1)으로 마이그레이션했습니다.`)
      }
    }
  }
  for (const [address, bech32] of Object.entries(persisted)) {
    try {
      keypairs.set(address, Ed25519Keypair.fromSecretKey(bech32))
    } catch (e) {
      console.error(`   ⚠️ wallet-keys.json 키 손상 (${address.slice(0, 10)}…): ${e.message}`)
    }
  }
  return keypairs.size
}

// CLI 키스토어(base64 flag||privkey 배열)에서 knownAddresses에 해당하는 키만 임포트
export function importFromCliKeystore(knownAddresses) {
  let entries
  try {
    entries = JSON.parse(fs.readFileSync(CLI_KEYSTORE, 'utf8'))
  } catch {
    return 0
  }
  const want = new Set(knownAddresses)
  let imported = 0
  for (const b64 of entries) {
    let kp
    try {
      const raw = Buffer.from(b64, 'base64')
      if (raw.length !== 33 || raw[0] !== 0x00) continue // ed25519(flag 0x00)만
      kp = Ed25519Keypair.fromSecretKey(raw.subarray(1))
    } catch {
      continue
    }
    const address = kp.toHaneulAddress()
    if (!want.has(address) || keypairs.has(address)) continue
    keypairs.set(address, kp)
    persisted[address] = kp.getSecretKey()
    imported++
  }
  if (imported) persist()
  return imported
}

export const keypairFor = address => keypairs.get(address) ?? null

export function createWallet() {
  const kp = Ed25519Keypair.generate()
  const address = kp.toHaneulAddress()
  keypairs.set(address, kp)
  persisted[address] = kp.getSecretKey()
  persist()
  return { address, keypair: kp }
}

// 가입 도중 온체인 등록이 실패했을 때의 롤백 — 고아 키가 저장소에 남지 않게
export function removeWallet(address) {
  if (!keypairs.delete(address)) return
  delete persisted[address]
  persist()
}
