// gRPC 테일링 등가 검증 — 같은 체크포인트 구간을 두 전송으로 읽어 이벤트가
// 비트 단위로 같은지 비교한다. 읽기 전용이라 어느 네트워크에나 안전.
//   ① 등가: JSON-RPC(getCheckpoints + multiGetTransactionBlocks, 구 테일링 경로)
//      vs gRPC(GetCheckpoint read_mask + checkpointToEvents, 신 테일링 경로)
//   ② 소크: SubscribeCheckpoints 스트림이 갭 없이 오름차순으로 오는지 N개 관찰
// 사용: HUMMING_NETWORK=mainnet node verify-grpc-tailing.mjs
import { client, grpcClient } from './lib/client.mjs'
import { checkpointToEvents, getCheckpointEvents, serviceInfo, subscribeCheckpoints } from './lib/grpc.mjs'

const ok = (label, cond, detail = '') => {
  if (!cond) throw new Error(`FAIL: ${label} ${detail}`)
  console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`)
}
// 키 순서 무관 딥 비교용 정규화 직렬화.
// 이벤트 type의 주소는 64자 패딩형으로 정규화한다 — JSON-RPC는 시스템 주소
// 7종(0x1~0x6, 0xdee9)만 축약하고(haneul_serde.rs to_haneul_struct_tag_string)
// gRPC는 전부 패딩한다. 유저 패키지(humming 포함)는 두 전송이 이미 동일하므로
// 이 정규화는 시스템 이벤트 비교에만 작용한다.
const padType = t => String(t).replace(/0x([0-9a-fA-F]{1,64})(?=::)/g, (_, a) => `0x${a.padStart(64, '0')}`)
const canon = v =>
  JSON.stringify(v, (k, x) => {
    if (k === 'type') return padType(x)
    return x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map(kk => [kk, x[kk]]))
      : x
  })

// 구 테일링 경로 그대로: 체크포인트 → 전 tx digest → 이벤트 (JSON-RPC)
async function jsonRpcEvents(seq) {
  const page = await client.getCheckpoints({ cursor: String(seq - 1), limit: 1, descendingOrder: false })
  const cp = page.data[0]
  if (Number(cp.sequenceNumber) !== seq) throw new Error(`checkpoint ${seq} 조회 불일치`)
  const out = []
  for (let i = 0; i < cp.transactions.length; i += 50) {
    const txs = await client.multiGetTransactionBlocks({
      digests: cp.transactions.slice(i, i + 50),
      options: { showEvents: true },
    })
    for (const tx of txs ?? [])
      for (const ev of tx?.events ?? [])
        out.push({
          type: ev.type,
          parsedJson: ev.parsedJson,
          id: { txDigest: ev.id.txDigest, eventSeq: String(ev.id.eventSeq) },
          timestampMs: Number(tx.timestampMs ?? cp.timestampMs),
        })
  }
  return out
}

const info = await serviceInfo()
const tip = Number(info.checkpointHeight)
const lowest = Number(info.lowestAvailableCheckpoint)
console.log(`체인 ${info.chain}, tip=${tip}, 프루닝 하한=${lowest}`)

// ① 등가 비교 대상: 최신 10개 + 직전 에폭 경계 주변 5개(에폭 전환 tx는 항상
// 이벤트를 갖고 있어, 조용한 체인에서도 parsedJson 변환이 실제로 검증된다)
const epoch = (
  await grpcClient.ledgerService.getEpoch({ readMask: { paths: ['epoch', 'first_checkpoint'] } })
).response.epoch
const boundary = Number(epoch.firstCheckpoint)
const seqs = []
for (let s = tip - 10; s < tip; s++) seqs.push(s)
if (boundary - 3 > lowest) for (let s = boundary - 3; s < boundary + 2; s++) seqs.push(s)

let totalEvents = 0
for (const seq of seqs) {
  const [viaJson, viaGrpc] = await Promise.all([
    jsonRpcEvents(seq),
    getCheckpointEvents(seq).then(cp => checkpointToEvents(cp).events),
  ])
  if (canon(viaJson) !== canon(viaGrpc))
    throw new Error(
      `FAIL: checkpoint ${seq} 이벤트 불일치\nJSON-RPC: ${canon(viaJson)}\ngRPC:     ${canon(viaGrpc)}`,
    )
  totalEvents += viaGrpc.length
}
ok('전송 간 이벤트 등가', true, `체크포인트 ${seqs.length}개, 이벤트 ${totalEvents}건 일치`)
ok('실 이벤트 표본 포함', totalEvents > 0, '(0건이면 parsedJson 변환이 검증되지 않은 것)')

// ② 스트림 소크: 갭 없는 오름차순 커서 + 어댑터 무오류
const SOAK = 20
const ac = new AbortController()
const stream = subscribeCheckpoints(ac.signal)
let prev = null
let n = 0
try {
  for await (const resp of stream.responses) {
    const seq = Number(resp.cursor)
    if (prev !== null && seq !== prev + 1) throw new Error(`FAIL: 스트림 갭 ${prev} → ${seq}`)
    checkpointToEvents(resp.checkpoint) // 어댑터가 스트림 페이로드에서도 무오류인지
    prev = seq
    if (++n >= SOAK) ac.abort()
  }
} catch (e) {
  if (!ac.signal.aborted) throw e
}
ok('구독 스트림 갭 없음', n >= SOAK, `${n}개 연속 수신 (${prev - SOAK + 1}~${prev})`)

console.log('\n🎉 전 항목 통과')
