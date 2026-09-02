// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// 결제 pending 화해의 판정 로직 검증 (순수 함수, 체인 조회 결과를 주입).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingDecision, PENDING_HORIZON_MS } from '../lib/pending.mjs'

const now = 1_700_000_000_000
const rec = over => ({ kind: 'tip', paramsHash: 'ab12', digest: 'DIGEST1', ts: now - 1000, ...over })

test('레코드 없음: 실행', () => {
  assert.deepEqual(pendingDecision(null, null, now), { action: 'execute' })
})

test('다이제스트 없는 레코드: 전송 전에 죽은 것, 정리 후 실행', () => {
  const d = pendingDecision(rec({ digest: null }), null, now)
  assert.equal(d.action, 'execute-clear')
  assert.equal(d.reason, 'never-sent')
})

test('체인에서 성공 확인: 이전 결과 반환 (재결제 금지)', () => {
  const d = pendingDecision(rec(), { found: true, succeeded: true }, now)
  assert.equal(d.action, 'return-prior')
  assert.equal(d.digest, 'DIGEST1')
})

test('체인에서 실패 확인: 정리 후 재실행 허용', () => {
  const d = pendingDecision(rec(), { found: true, succeeded: false }, now)
  assert.equal(d.action, 'execute-clear')
  assert.equal(d.reason, 'failed-on-chain')
})

test('체인에 안 보이고 아직 이르면: 차단 (판정 유보)', () => {
  const d = pendingDecision(rec({ ts: now - 5000 }), { found: false }, now)
  assert.equal(d.action, 'block')
})

test('체인에 안 보이고 지평선을 넘겼으면: 미전송 확정, 재실행 허용', () => {
  const d = pendingDecision(rec({ ts: now - PENDING_HORIZON_MS - 1000 }), { found: false }, now)
  assert.equal(d.action, 'execute-clear')
  assert.equal(d.reason, 'not-on-chain')
})

test('지평선을 넘겼어도 체인 성공이 확인되면 이전 결과가 우선한다', () => {
  const d = pendingDecision(
    rec({ ts: now - PENDING_HORIZON_MS * 3 }),
    { found: true, succeeded: true },
    now,
  )
  assert.equal(d.action, 'return-prior')
})
