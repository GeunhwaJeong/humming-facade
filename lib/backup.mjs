// 내구 상태 스냅샷 백업 — 키·계정·시크릿·커서는 "서버 디스크가 유일한 원본"이라
// 디스크 손실 = 전 유저 자금·수익이력 소실이었다. 여기서는 상태 파일 일체를
// 주기 + 변경 직후(디바운스)로 로컬 스냅샷 디렉토리에 복사하고 오래된 것을
// 정리한다. 오프사이트 복제는 HUMMING_BACKUP_CMD 훅에 위임한다(rclone/aws-cli 등,
// 의존성 추가 없이). 지갑 키 파일은 암호화 저장(keys.mjs)이 선행되므로 스냅샷
// 사본이 유출되어도 패스프레이즈 없이는 읽을 수 없다.
//
// 복원 절차: 스냅샷 디렉토리의 파일들을 repo 루트로 복사한 뒤 서버를 재시작한다.
// manifest.json의 sha256으로 사본 무결성을 먼저 확인할 것.
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NETWORK } from './config.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BACKUP_DIR = process.env.HUMMING_BACKUP_DIR || path.join(ROOT, 'backups')
const KEEP = Number(process.env.HUMMING_BACKUP_KEEP ?? 48)
const INTERVAL_MS = Number(process.env.HUMMING_BACKUP_INTERVAL_MS ?? 6 * 60 * 60 * 1000)
// 변경 직후 백업의 디바운스 — 가입 폭주 때 스냅샷이 초 단위로 쌓이는 것을 막는다
const DEBOUNCE_MS = Number(process.env.HUMMING_BACKUP_DEBOUNCE_MS ?? 60_000)

// 백업 대상: 재구성 불가능한 원본만. media/는 용량 문제로 제외(오프사이트 훅에서
// 별도로 다루는 것을 권장), 커서는 재구성 가능하지만 백필 시간을 아끼므로 포함.
// 이벤트 저널은 프루닝된 과거 이벤트(팁 이력 등)의 유일한 원본이라 반드시 포함
// (journal.mjs 규약: 커서와 저널 두 파일 모두 백업 대상).
// export는 테스트용: 백업 목록에서 저널이 다시 빠지는 회귀를 잡는다.
export const STATE_FILES = [
  NETWORK === 'mainnet' ? 'wallet-keys.mainnet.json' : 'wallet-keys.json',
  NETWORK === 'mainnet' ? 'accounts.mainnet.json' : 'accounts.json',
  '.jwt-secret',
  `indexer-cursor.${NETWORK}.json`,
  `events.${NETWORK}.jsonl`,
  `revoked-sessions.${NETWORK}.json`,
]

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

export function snapshot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(BACKUP_DIR, `${NETWORK}-${stamp}`)
  const manifest = { createdAt: new Date().toISOString(), network: NETWORK, files: {} }
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const name of STATE_FILES) {
      const src = path.join(ROOT, name)
      let buf
      try {
        buf = fs.readFileSync(src)
      } catch {
        continue // 아직 생성되지 않은 파일(첫 부팅 등)은 건너뜀
      }
      fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 })
      manifest.files[name] = { sha256: sha256(buf), size: buf.length }
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    })
    prune()
    runOffsiteHook(dir)
    return dir
  } catch (e) {
    // 백업 실패가 본 서비스를 죽여선 안 된다 — 기록만 남기고 다음 주기에 재시도
    console.error(`⚠️ 백업 스냅샷 실패: ${e.message}`)
    return null
  }
}

function prune() {
  let entries
  try {
    entries = fs
      .readdirSync(BACKUP_DIR)
      .filter(d => d.startsWith(`${NETWORK}-`))
      .sort()
  } catch {
    return
  }
  for (const stale of entries.slice(0, Math.max(0, entries.length - KEEP))) {
    fs.rmSync(path.join(BACKUP_DIR, stale), { recursive: true, force: true })
  }
}

// 오프사이트 복제 훅: 스냅샷 완료 후 셸 명령을 비동기 실행. 예:
//   HUMMING_BACKUP_CMD='rclone copy "$HUMMING_BACKUP_PATH" remote:humming-backups/'
function runOffsiteHook(dir) {
  const cmd = process.env.HUMMING_BACKUP_CMD
  if (!cmd) return
  execFile('/bin/sh', ['-c', cmd], { env: { ...process.env, HUMMING_BACKUP_PATH: dir } }, err => {
    if (err) console.error(`⚠️ 백업 오프사이트 훅 실패: ${err.message}`)
  })
}

let debounceTimer = null
// 상태 파일이 바뀔 때(가입·계정 변경) 호출 — 디바운스 후 스냅샷.
// 새 유저의 키가 다음 6시간 주기까지 디스크 한 곳에만 존재하는 창을 줄인다.
export function noteChange() {
  if (debounceTimer) return
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    snapshot()
  }, DEBOUNCE_MS)
  debounceTimer.unref?.()
}

export function startBackups() {
  const first = snapshot()
  if (first) console.log(`🗄️ 상태 백업 시작: ${first} (주기 ${INTERVAL_MS / 60000}분, 보관 ${KEEP}개)`)
  setInterval(snapshot, INTERVAL_MS).unref?.()
}
