// SDK 클라이언트 단일 인스턴스 — chain(쓰기)과 indexer(읽기)가 공유.
// 별도 모듈인 이유: chain ↔ indexer 순환 import 방지
import { HaneulJsonRpcClient } from '@haneullabs/haneul/jsonRpc'
import { RPC_URL } from './config.mjs'

export const client = new HaneulJsonRpcClient({ network: 'localnet', url: RPC_URL })
