// GraphQL 갭 백필 — 장시간 다운 뒤 놓친 체크포인트 구간의 우리 패키지 이벤트를 모듈별
// 이벤트 타입 필터 쿼리로 가져온다. 결과는 인덱서·저널·gRPC 테일링과 같은 어휘
// ({type, parsedJson, id:{txDigest, eventSeq}, timestampMs})로 변환하므로 dedupe 키
// `${txDigest}:${eventSeq}`가 저널의 기존 관측과 그대로 맞물린다 (GraphQL의
// Event.sequenceNumber = tx 내 이벤트 인덱스 = gRPC/JSON-RPC eventSeq, 테스트넷·메인넷 실측).
//
// 필터 경계: afterCheckpoint/beforeCheckpoint는 배타, atCheckpoint는 포함 (실측).
// 그래서 (after, through] 구간은 afterCheckpoint=after, beforeCheckpoint=through+1.
// 이 모듈은 평시 경로에 관여하지 않는다 — indexer.catchUp이 갭이 클 때만 부른다.
import { GRAPHQL_URL } from './config.mjs'

// 필터는 이벤트 타입으로 건다 (인덱서가 소비하는 타입 목록을 호출자가 넘긴다). `module`
// 필터는 "이벤트를 낸 모듈"(transactionModule) 기준이라 타입의 정의 모듈과 다를 수 있어
// 쓰지 않는다 — 타입은 인덱서가 키로 삼는 그 문자열이라 모호함이 없다.
const PAGE = 50
const QUERY = `query($f:EventFilter!,$after:String){ events(first:${PAGE}, filter:$f, after:$after){ pageInfo{hasNextPage endCursor} nodes{ sequenceNumber timestamp contents{ type{ repr } json } transaction{ digest effects{ checkpoint{ sequenceNumber } } } } } }`

export function toIndexerEvent(node) {
  return {
    type: node.contents.type.repr,
    parsedJson: node.contents.json,
    id: { txDigest: node.transaction.digest, eventSeq: String(node.sequenceNumber) },
    timestampMs: Date.parse(node.timestamp),
    checkpoint: Number(node.transaction.effects.checkpoint.sequenceNumber),
  }
}

export function shouldBackfill(gap, { url = GRAPHQL_URL, min } = {}) {
  return !!url && gap >= min
}

async function post(url, variables, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables }),
  })
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`)
  const body = await res.json()
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors[0].message}`)
  return body.data.events
}

// (afterCheckpoint, throughCheckpoint] 구간의 주어진 타입들의 이벤트 전량, 체크포인트 오름차순.
// types는 `${PKG}::module::Event` 전체 문자열. 쿼리는 순차로 보낸다 — 공공 GraphQL도
// 제한이 있고, 갭 복원은 한 번에 끝나는 작업이라 서두를 이유가 없다.
export async function fetchGapEvents(
  afterCheckpoint,
  throughCheckpoint,
  types,
  { url = GRAPHQL_URL, fetchImpl = fetch } = {},
) {
  if (!url) throw new Error('GraphQL URL not configured')
  if (!types?.length) throw new Error('No event types to backfill')
  const events = []
  for (const type of types) {
    let after = null
    for (;;) {
      const page = await post(
        url,
        { f: { type, afterCheckpoint, beforeCheckpoint: throughCheckpoint + 1 }, after },
        fetchImpl,
      )
      for (const n of page.nodes) events.push(toIndexerEvent(n))
      if (!page.pageInfo.hasNextPage) break
      after = page.pageInfo.endCursor
    }
  }
  // 모듈별 결과를 체인 순서로 합친다. 한 tx 안의 순서는 eventSeq, tx 간은 체크포인트·시각으로.
  events.sort(
    (a, b) =>
      a.checkpoint - b.checkpoint ||
      a.timestampMs - b.timestampMs ||
      a.id.txDigest.localeCompare(b.id.txDigest) ||
      Number(a.id.eventSeq) - Number(b.id.eventSeq),
  )
  return events
}
