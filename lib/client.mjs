// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// SDK 클라이언트 단일 인스턴스 — chain(쓰기)·indexer(테일링)·bootstrap(객체 읽기)·
// server(잔고/이름 조회)가 공유한다. 별도 모듈인 이유: 순환 import 방지.
//
// 전송은 gRPC 단일이다. 노드가 JSON-RPC와 같은 포트에 gRPC를 다중화하고 grpc-web
// 레이어를 갖추고 있어 URL을 공유하며, 업스트림의 퍼블릭 JSON-RPC 폐기와 무관하게
// 동작한다. JSON-RPC 클라이언트는 런타임에서 완전히 제거됐다 (등가 검증 스크립트만
// 비교 목적으로 자체 생성해 쓴다).
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { GRPC_NETWORK, GRPC_URL } from './config.mjs'

export const grpcClient = new SuiGrpcClient({
  network: GRPC_NETWORK,
  baseUrl: GRPC_URL,
  format: 'binary',
})
