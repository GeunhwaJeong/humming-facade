// 지갑 키 관리 — 파사드 소유 키 저장소(wallet-keys.json) + CLI 키스토어 1회 임포트.
// CLI 키스토어는 읽기 전용으로만 접근하고, 파사드가 아는 계정 주소의 키만 가져온다
// (파운더·운영 키는 절대 복사하지 않음). 신규 가입 키는 인프로세스 생성.
import fs from 'node:fs'
import { Ed25519Keypair } from '@haneullabs/haneul/keypairs/ed25519'
import { writeFileAtomic } from './atomic.mjs'
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

// 비밀키 파일은 소유자 전용(0600). 전 사용자 수탁 키의 단일 원본이므로 반드시
// 원자적으로 교체한다 — 쓰기 도중 크래시가 파일을 깨면 복구 수단이 없다.
const persist = () => {
  writeFileAtomic(KEYS_FILE, JSON.stringify(persisted, null, 2), { mode: 0o600 })
}

export function loadKeys() {
  try {
    persisted = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'))
    fs.chmodSync(KEYS_FILE, 0o600) // 과거 0644로 생성된 파일 교정
  } catch {
    persisted = {}
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
