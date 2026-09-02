// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// 신고 입력 검증과 운영자 숨김 목록의 영속·왕복.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkReport, hidePost, unhidePost, isHidden, listHidden, loadHidden, MAX_REPORT_REASON_CHARS } from '../lib/moderation.mjs'

test('신고는 ATProto 사유 타입과 레코드/계정 대상을 요구한다', () => {
  assert.equal(checkReport({ reasonType: 'com.atproto.moderation.defs#reasonSexual', subject: { uri: 'at://did:web:a/app.bsky.feed.post/1' } }), null)
  assert.equal(checkReport({ reasonType: 'tools.ozone.report.defs#reasonAppeal', reason: 'x', subject: { did: 'did:web:a' } }), null)
  assert.notEqual(checkReport({ reasonType: 'whatever', subject: { did: 'did:web:a' } }), null)
  assert.notEqual(checkReport({ reasonType: 'com.atproto.moderation.defs#reasonSpam', subject: { uri: 'http://x' } }), null)
  assert.notEqual(checkReport({ reasonType: 'com.atproto.moderation.defs#reasonSpam' }), null)
  assert.notEqual(checkReport({ reasonType: 'com.atproto.moderation.defs#reasonSpam', reason: 'a'.repeat(MAX_REPORT_REASON_CHARS + 1), subject: { did: 'did:web:a' } }), null)
})

test('숨김은 디스크에 남고 다시 읽힌다', () => {
  const id = `9${Date.now()}`
  hidePost(id, { by: 'admin', reason: 'test' })
  assert.ok(isHidden(id))
  assert.ok(isHidden(Number(id)))
  loadHidden()
  assert.ok(isHidden(id))
  assert.ok(listHidden().some(h => h.postId === id && h.reason === 'test' && h.by === 'admin'))
  assert.equal(unhidePost(id), true)
  assert.equal(unhidePost(id), false)
  loadHidden()
  assert.ok(!isHidden(id))
})
