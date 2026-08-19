// gRPC 체크포인트 읽기 어댑터 — 인덱서 테일링이 쓰는 표면만 감싼다.
// 반환 이벤트를 JSON-RPC 이벤트 형태({type, parsedJson, id, timestampMs})로
// 맞춰서, 인덱서·저널·동기 주입(chain.mjs)이 한 가지 어휘를 유지하게 한다 —
// 저널에 이미 쌓인 과거 레코드와도 그대로 호환된다.
import { grpcClient } from './client.mjs'

// Checkpoint 메시지 기준 read_mask. GetCheckpoint와 SubscribeCheckpoints가 같은
// 경로 어휘를 쓴다 (구독 read_mask도 서버에서 Checkpoint 기준으로 검증된다).
// 경로가 스키마와 어긋나면 FIELD_INVALID로 즉시 거부되므로 여기 한 곳에만 둔다.
const CHECKPOINT_EVENTS_MASK = {
  paths: ['sequence_number', 'summary.timestamp', 'transactions.digest', 'transactions.events'],
}

// google.protobuf.Value → 평범한 JS 값. 노드가 u64를 문자열로, 주소를 0x-패딩으로
// 렌더링해 주므로 변환 결과가 JSON-RPC parsedJson과 동일한 표면이 된다 (실측 확인).
function valueToJs(v) {
  switch (v?.kind?.oneofKind) {
    case 'nullValue':
      return null
    case 'numberValue':
      return v.kind.numberValue
    case 'stringValue':
      return v.kind.stringValue
    case 'boolValue':
      return v.kind.boolValue
    case 'structValue': {
      const out = {}
      for (const [k, f] of Object.entries(v.kind.structValue.fields ?? {})) out[k] = valueToJs(f)
      return out
    }
    case 'listValue':
      return (v.kind.listValue.values ?? []).map(valueToJs)
    default:
      return undefined
  }
}

const tsToMs = ts =>
  ts == null ? undefined : Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6)

// gRPC Checkpoint → ingestEvents가 그대로 먹는 이벤트 배열.
// eventSeq는 tx 내 이벤트 배열 인덱스 — JSON-RPC의 eventSeq와 동일한 값이라
// `${txDigest}:${eventSeq}` dedupe 키가 저널·동기 주입과 계속 맞물린다.
export function checkpointToEvents(checkpoint) {
  const timestampMs = tsToMs(checkpoint?.summary?.timestamp)
  const events = []
  for (const tx of checkpoint?.transactions ?? []) {
    const txEvents = tx.events?.events ?? []
    for (let i = 0; i < txEvents.length; i++) {
      const ev = txEvents[i]
      events.push({
        type: ev.eventType,
        parsedJson: valueToJs(ev.json),
        id: { txDigest: tx.digest, eventSeq: String(i) },
        timestampMs: tsToMs(tx.timestamp) ?? timestampMs,
      })
    }
  }
  return { events, timestampMs }
}

export async function serviceInfo() {
  return (await grpcClient.ledgerService.getServiceInfo({})).response
}

export async function getCheckpointEvents(sequenceNumber) {
  const { response } = await grpcClient.ledgerService.getCheckpoint({
    checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber: BigInt(sequenceNumber) },
    readMask: CHECKPOINT_EVENTS_MASK,
  })
  return response.checkpoint
}

// 서버 스트리밍 구독 — 최신 실행 체크포인트부터 순서 보장·갭 없음.
// abort signal은 워치독(수신 침묵 감지)이 스트림을 강제 종료하는 데 쓴다.
export function subscribeCheckpoints(signal) {
  return grpcClient.subscriptionService.subscribeCheckpoints(
    { readMask: CHECKPOINT_EVENTS_MASK },
    signal ? { abort: signal } : undefined,
  )
}

// 체크포인트가 프루닝 하한 밑이라 이 노드에서 복구 불가한 경우의 판별
export const isUnavailable = e =>
  e?.code === 'NOT_FOUND' || /not found|could not find|pruned/i.test(String(e?.message))
