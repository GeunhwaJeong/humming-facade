// 모더레이션 상태 — 신고 원장과 운영자 숨김 목록. 둘 다 체인 밖 파사드 원본이다:
// 신고는 유저가 운영자에게 보내는 메시지라 온체인일 이유가 없고, 숨김은 "즉시 효력"이
// 요건이라 체인 확정을 기다릴 수 없다(작성자 삭제는 온체인 delete_post, server.mjs).
//
// - reports.<network>.jsonl: append-only. 크래시로 잘려도 마지막 줄만 손실.
// - hidden-posts.<network>.json: postId → {by, reason, ts}. 원자적으로 교체.
// 두 파일 모두 백업 대상(backup.mjs STATE_FILES) — 분쟁·이의제기 재구성의 증거다.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { writeFileAtomic } from './atomic.mjs'
import { NETWORK } from './config.mjs'

const REPORTS_URL = new URL(`../reports.${NETWORK}.jsonl`, import.meta.url)
const HIDDEN_URL = new URL(`../hidden-posts.${NETWORK}.json`, import.meta.url)

// ---- 신고 ----
// ATProto 사유 타입: com.atproto.moderation.defs#reason* / tools.ozone.report.defs#reason*.
// 알 수 없는 문자열도 운영자에게는 정보이므로 형태만 확인하고 그대로 남긴다.
export const MAX_REPORT_REASON_CHARS = 2000
export function checkReport({ reasonType, reason, subject }) {
  if (typeof reasonType !== 'string' || !/^[a-z][\w.-]*#reason[\w-]*$/i.test(reasonType))
    return 'reasonType must be an ATProto moderation reason'
  if (reason != null && (typeof reason !== 'string' || reason.length > MAX_REPORT_REASON_CHARS))
    return `reason must be a string of at most ${MAX_REPORT_REASON_CHARS} characters`
  if (!subject || typeof subject !== 'object') return 'subject is required'
  const isRecord = typeof subject.uri === 'string' && subject.uri.startsWith('at://')
  const isRepo = typeof subject.did === 'string' && subject.did.startsWith('did:')
  if (!isRecord && !isRepo) return 'subject must be a record (uri) or an account (did)'
  return null
}

export function appendReport({ reportedBy, reasonType, reason, subject }) {
  const rec = {
    id: crypto.randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
    reportedBy,
    reasonType,
    reason: reason ?? '',
    subject: subject.uri
      ? { $type: 'com.atproto.repo.strongRef', uri: subject.uri, ...(subject.cid && { cid: subject.cid }) }
      : { $type: 'com.atproto.admin.defs#repoRef', did: subject.did },
  }
  fs.appendFileSync(REPORTS_URL, JSON.stringify(rec) + '\n', { mode: 0o600 })
  return rec
}

// 최신순. 운영자 조회용이라 전량 읽고 자른다 (신고량은 게시물 수보다 훨씬 적다)
export function listReports(limit = 100) {
  let raw
  try {
    raw = fs.readFileSync(REPORTS_URL, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 잘린 마지막 줄
    }
  }
  return out.reverse().slice(0, limit)
}

// ---- 운영자 숨김 ----
const hidden = new Map() // postId → {by, reason, ts}

export function loadHidden() {
  hidden.clear()
  try {
    for (const [id, v] of Object.entries(JSON.parse(fs.readFileSync(HIDDEN_URL, 'utf8'))))
      hidden.set(String(id), v)
  } catch {
    // 파일 부재(첫 부팅). 손상이면 빈 목록으로 뜨는데, 이 축의 오류는 "숨김 해제"라
    // 즉시 눈에 띈다 — 백업에서 복원한다
  }
  return hidden.size
}

const persistHidden = () =>
  writeFileAtomic(HIDDEN_URL, JSON.stringify(Object.fromEntries(hidden), null, 2), { mode: 0o600 })

export const isHidden = postId => hidden.has(String(postId))
export const hiddenEntry = postId => hidden.get(String(postId)) ?? null
export const listHidden = () => [...hidden].map(([postId, v]) => ({ postId, ...v }))

export function hidePost(postId, { by, reason }) {
  const rec = { by, reason: reason ?? '', ts: Date.now() }
  hidden.set(String(postId), rec)
  persistHidden()
  return rec
}

export function unhidePost(postId) {
  if (!hidden.delete(String(postId))) return false
  persistHidden()
  return true
}

loadHidden()
