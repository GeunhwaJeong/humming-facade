// 이벤트 저널 — 인덱서가 관측한 실제 온체인 이벤트의 append-only 영속층.
// 풀노드는 2에폭(~2일)보다 오래된 tx/이벤트를 프루닝하므로 "체인에 다시
// 물어보기"는 재시작 복구 전략이 될 수 없다 (2026-07-29 전면 장애의 원인).
// 관측 즉시 디스크에 남기고 부팅 때 리플레이한다. 저널에는 관측된 원본
// 이벤트만 담는다 — 객체 재구성 산물(bootstrap)은 매 부팅 체인에서 다시
// 만들 수 있으므로 저장하지 않는다.
//
// ⚠️ 두 파일 모두 wallet-keys처럼 서버가 원본인 데이터 — 배포 시 덮어쓰기
// 금지(rsync exclude 목록에 포함), 백업 대상.
import fs from 'node:fs'
import { writeFileAtomic } from './atomic.mjs'
import { NETWORK } from './config.mjs'

const JOURNAL_URL = new URL(`../events.${NETWORK}.jsonl`, import.meta.url)
const CURSOR_URL = new URL(`../indexer-cursor.${NETWORK}.json`, import.meta.url)

// 레코드 형태는 RPC 이벤트와 동일({id, type, parsedJson, timestampMs}) —
// 리플레이가 ingestEvents를 그대로 통과한다
export function loadJournal() {
  let raw
  try {
    raw = fs.readFileSync(JOURNAL_URL, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 크래시로 잘린 마지막 줄 — 커서가 그 앞에 저장돼 있어 테일링이 다시 채운다
    }
  }
  return events
}

export function appendJournal(ev) {
  fs.appendFileSync(JOURNAL_URL, JSON.stringify(ev) + '\n', { mode: 0o600 })
}

export function loadCursor() {
  try {
    const v = JSON.parse(fs.readFileSync(CURSOR_URL, 'utf8'))
    return Number.isFinite(v.checkpoint) ? v.checkpoint : null
  } catch {
    return null
  }
}

export function saveCursor(checkpoint) {
  writeFileAtomic(CURSOR_URL, JSON.stringify({ checkpoint }), { mode: 0o600 })
}
