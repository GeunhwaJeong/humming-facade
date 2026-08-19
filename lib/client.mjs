// SDK 클라이언트 단일 인스턴스 — chain(쓰기)과 indexer(읽기)가 공유.
// 별도 모듈인 이유: chain ↔ indexer 순환 import 방지
import { HaneulJsonRpcClient } from '@haneullabs/haneul/jsonRpc'
import { HaneulGrpcClient } from '@haneullabs/haneul/grpc'
import { NETWORK, RPC_URL, GRPC_URL } from './config.mjs'

export const client = new HaneulJsonRpcClient({ network: 'localnet', url: RPC_URL })

// gRPC 클라이언트 — 인덱서 테일링(체크포인트 조회·구독)이 사용. 노드가 JSON-RPC와
// 같은 포트에 gRPC를 다중화하고 grpc-web 레이어를 갖추고 있어 URL을 공유한다.
// 업스트림의 퍼블릭 JSON-RPC 폐기 이후에도 살아남는 경로는 이쪽이다.
export const grpcClient = new HaneulGrpcClient({
  network: NETWORK,
  baseUrl: GRPC_URL,
  format: 'binary',
})
