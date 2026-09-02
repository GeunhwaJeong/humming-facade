// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// 백업 대상 목록 회귀 방지: 서버 디스크가 유일한 원본인 파일이 목록에서 빠지면
// 디스크 손실 = 데이터 소실이다. 특히 이벤트 저널(과거 팁 이력의 유일한 원본).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STATE_FILES } from '../lib/backup.mjs'
import { NETWORK } from '../lib/config.mjs'

test('이벤트 저널이 백업 목록에 있다', () => {
  assert.ok(STATE_FILES.includes(`events.${NETWORK}.jsonl`))
})

test('키 저장소·계정·시크릿·커서·세션 폐기 목록이 백업 목록에 있다', () => {
  const wallet = NETWORK === 'mainnet' ? 'wallet-keys.mainnet.json' : 'wallet-keys.json'
  const accounts = NETWORK === 'mainnet' ? 'accounts.mainnet.json' : 'accounts.json'
  for (const f of [wallet, accounts, '.jwt-secret', `indexer-cursor.${NETWORK}.json`, `revoked-sessions.${NETWORK}.json`]) {
    assert.ok(STATE_FILES.includes(f), `${f} missing from STATE_FILES`)
  }
})
