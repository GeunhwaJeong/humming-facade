// 결제 tx의 영속 pending 기록. 인메모리 멱등층(idempotency.mjs)이 못 덮는 창을 닫는다:
// 실행 응답이 유실되거나(waitForTransaction 타임아웃, gRPC 단절) 프로세스가 죽으면
// 체인에서는 성공했는데 파사드는 실패로 알고, 클라이언트 재시도가 두 번째 결제가 된다.
//
// 프로토콜: 결제 tx마다 전송 전에 begin 레코드를 append하고, 다이제스트가 확정되는
// 즉시(서명 직전, 실행 전) digest 레코드를 append하고, 결과가 확정되면 resolved를
// append한다. 재시도·재부팅 때 미해결 레코드가 있으면 그 다이제스트로 체인을 먼저
// 조회해 "이미 결제됐는가"를 판정한다. 다이제스트 없는 레코드는 전송 전에 죽은
// 것이므로(디지스트 확정이 전송보다 먼저다) 재실행이 안전하다.
//
// 파일은 저널과 같은 append-only jsonl이고, 부팅 시 미해결 항목만 남겨 압축한다.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { writeFileAtomic } from './atomic.mjs'
import { grpcClient } from './client.mjs'
import { NETWORK } from './config.mjs'

const PENDING_URL = new URL(`../pending-tx.${NETWORK}.jsonl`, import.meta.url)
const SIGNUPS_URL = new URL(`../pending-signups.${NETWORK}.json`, import.meta.url)

// 다이제스트가 있는데 체인에서 안 보이는 tx를 "전송 안 됨"으로 판정해도 되는 시점.
// 실행된 tx는 수 초 안에 체크포인트에 실리므로 60초면 충분히 보수적이다.
export const PENDING_HORIZON_MS = 60_000
// 이 나이를 넘긴 미해결 레코드는 청소한다 (멱등 캐시 최대 창과 동일한 10분:
// 그보다 늦은 재시도는 어차피 멱등층도 새 요청으로 본다)
export const PENDING_RETENTION_MS = 10 * 60_000

const pending = new Map() // key → { kind, paramsHash, digest, ts }

const append = rec => fs.appendFileSync(PENDING_URL, JSON.stringify(rec) + '\n', { mode: 0o600 })

export const pendingFor = key => pending.get(key) ?? null
export const pendingCount = () => pending.size

// jsonl 리플레이로 미해결 항목만 복원하고, 파일을 그 항목들로 압축해 다시 쓴다
export function loadPending() {
  pending.clear()
  let raw = null
  try {
    raw = fs.readFileSync(PENDING_URL, 'utf8')
  } catch {
    return pending // 첫 부팅
  }
  for (const line of raw.split('\n')) {
    if (!line) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue // 크래시로 잘린 마지막 줄
    }
    if (rec.op === 'begin')
      pending.set(rec.key, { kind: rec.kind, paramsHash: rec.paramsHash, digest: null, ts: rec.ts })
    else if (rec.op === 'digest') {
      const p = pending.get(rec.key)
      if (p) p.digest = rec.digest
    } else if (rec.op === 'resolved') pending.delete(rec.key)
  }
  compact()
  return pending
}

function compact() {
  const lines = []
  for (const [key, p] of pending) {
    lines.push(JSON.stringify({ op: 'begin', key, kind: p.kind, paramsHash: p.paramsHash, ts: p.ts }))
    if (p.digest) lines.push(JSON.stringify({ op: 'digest', key, digest: p.digest }))
  }
  writeFileAtomic(PENDING_URL, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 })
}

export function beginPending(key, kind, params) {
  const paramsHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(params ?? {}))
    .digest('hex')
    .slice(0, 16)
  const ts = Date.now()
  pending.set(key, { kind, paramsHash, digest: null, ts })
  append({ op: 'begin', key, kind, paramsHash, ts })
}

export function notePendingDigest(key, digest) {
  const p = pending.get(key)
  if (p) p.digest = digest
  append({ op: 'digest', key, digest })
}

export function resolvePending(key, status) {
  pending.delete(key)
  append({ op: 'resolved', key, status, ts: Date.now() })
}

// 순수 판정 로직 (테스트 대상): 미해결 레코드와 체인 조회 결과를 받아 행동을 정한다.
//   execute        레코드 없음, 새로 실행
//   return-prior   체인에서 성공 확인, 이전 결과(digest)를 그대로 반환 (재결제 금지)
//   execute-clear  이전 시도는 확정 실패(체인 실패 tx, 또는 전송 전 사망), 정리 후 실행
//   block          다이제스트는 있는데 아직 체인에서 판정 불가, 재시도 대기 요청
export function pendingDecision(rec, lookup, now = Date.now()) {
  if (!rec) return { action: 'execute' }
  if (!rec.digest) return { action: 'execute-clear', reason: 'never-sent' }
  if (lookup?.found) {
    return lookup.succeeded
      ? { action: 'return-prior', digest: rec.digest }
      : { action: 'execute-clear', reason: 'failed-on-chain' }
  }
  if (now - rec.ts > PENDING_HORIZON_MS) return { action: 'execute-clear', reason: 'not-on-chain' }
  return { action: 'block' }
}

// 다이제스트로 체인 조회. found=false는 "그 다이제스트의 tx가 없다"의 확인이다
async function lookupOnChain(digest) {
  try {
    // succeeded는 실행 결과(effects.status)로 판정해야 한다. "체인에 실렸는가"만으로는
    // abort된 결제를 성공으로 오판하고, 반대로 존재 여부 이외의 필드를 잘못 읽으면
    // 성공한 결제를 실패로 오판해 재실행(이중결제)하게 된다.
    const res = await grpcClient.getTransaction({ digest })
    // 응답은 {$kind, Transaction|FailedTransaction} 유니온 — status는 언랩 후에 있다
    // (chain.mjs의 실행 응답 언랩과 같은 형태. 최상위 res.status는 항상 undefined라
    // 그걸 읽으면 성공한 결제를 실패로 오판해 재실행 = 이중결제가 된다)
    const t = res.Transaction ?? res.FailedTransaction
    return { found: !!t, succeeded: t?.status?.success === true }
  } catch (e) {
    if (e?.code === 'NOT_FOUND' || /not.?found/i.test(String(e?.message))) return { found: false }
    throw e // 체인 연결 실패 등은 판정 불가, 호출자에게 그대로
  }
}

// 결제 실행 래퍼. exec(onDigest)는 실행 직전에 onDigest(digest)를 불러야 한다.
// 실패(throw) 시 레코드를 남겨 둔다: 그 실패가 응답 유실이었다면 다음 재시도가
// 다이제스트로 체인을 조회해 재결제 대신 이전 결과를 돌려준다.
export async function withPendingTx(key, kind, params, exec) {
  sweep()
  const rec = pendingFor(key)
  if (rec) {
    const lookup = rec.digest ? await lookupOnChain(rec.digest) : null
    const d = pendingDecision(rec, lookup)
    if (d.action === 'return-prior') {
      resolvePending(key, 'success-prior')
      return { digest: d.digest, events: [], prior: true }
    }
    if (d.action === 'block') {
      const e = new Error('A previous payment attempt is still being confirmed, try again shortly')
      e.status = 409
      e.errorName = 'PendingTransaction'
      throw e
    }
    resolvePending(key, d.reason) // execute-clear
  }
  beginPending(key, kind, params)
  const out = await exec(digest => notePendingDigest(key, digest))
  resolvePending(key, 'success')
  return out
}

// 오래 미해결인 레코드 청소. 재시도 창(10분)이 지난 레코드는 판정할 상대가 없다
function sweep() {
  const cutoff = Date.now() - PENDING_RETENTION_MS
  for (const [key, p] of pending) if (p.ts < cutoff) resolvePending(key, 'expired')
}

// 부팅 화해: 확정 가능한 레코드(체인 성공/실패, 전송 전 사망, 보관 기한 초과)는
// 정리하고, 성공이 확인됐지만 아직 재시도가 올 수 있는 젊은 레코드는 남겨 둔다.
export async function reconcilePendingTxs() {
  sweep()
  let kept = 0
  for (const [key, rec] of [...pending]) {
    if (!rec.digest) {
      resolvePending(key, 'never-sent')
      continue
    }
    let lookup
    try {
      lookup = await lookupOnChain(rec.digest)
    } catch {
      kept++ // 체인 조회 실패: 다음 기회에 다시
      continue
    }
    if (lookup.found && lookup.succeeded) {
      kept++ // 성공 확인: 재시도가 return-prior를 받을 수 있게 유지 (sweep이 청소)
    } else if (lookup.found) {
      resolvePending(key, 'failed-on-chain')
    } else if (Date.now() - rec.ts > PENDING_HORIZON_MS) {
      resolvePending(key, 'not-on-chain')
    } else {
      kept++
    }
  }
  return { kept }
}

// ---- 가입 pending: 온체인 이름 등록과 계정 파일 기록 사이의 크래시 창 ----
// 체인 호출 전에 (handle, address, passwordHash)를 남기고, 계정 등록이 끝나면 지운다.
// 부팅 화해(server.mjs)는 leaf가 체인에 있으면 계정을 입양하고, 없으면 지갑을 롤백한다.
export function loadPendingSignups() {
  try {
    const list = JSON.parse(fs.readFileSync(SIGNUPS_URL, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function addPendingSignup(rec) {
  const list = loadPendingSignups().filter(r => r.handle !== rec.handle)
  list.push(rec)
  writeFileAtomic(SIGNUPS_URL, JSON.stringify(list, null, 2), { mode: 0o600 })
}

export function removePendingSignup(handle) {
  const list = loadPendingSignups().filter(r => r.handle !== handle)
  writeFileAtomic(SIGNUPS_URL, JSON.stringify(list, null, 2), { mode: 0o600 })
}

loadPending()
