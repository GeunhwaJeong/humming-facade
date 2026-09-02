// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// 피드 커서 페이지네이션의 슬라이스 로직 검증.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampLimit, pagePosts } from '../lib/paginate.mjs'

// 최신순(post_id 내림차순) 리스트: postId 19..0
const list = Array.from({ length: 20 }, (_, i) => ({ postId: String(19 - i) }))

test('clampLimit: 기본 50, 최대 100, 이상값은 기본값', () => {
  assert.equal(clampLimit(undefined), 50)
  assert.equal(clampLimit('25'), 25)
  assert.equal(clampLimit(1000), 100)
  assert.equal(clampLimit(0), 50)
  assert.equal(clampLimit(-5), 50)
  assert.equal(clampLimit('abc'), 50)
  assert.equal(clampLimit(7.9), 7)
})

test('첫 페이지: limit개 반환, 다음 커서는 마지막 postId', () => {
  const { items, cursor } = pagePosts(list, 5, undefined)
  assert.deepEqual(items.map(p => p.postId), ['19', '18', '17', '16', '15'])
  assert.equal(cursor, '15')
})

test('커서 페이지: 직전 마지막의 다음부터 이어진다 (중복·건너뜀 없음)', () => {
  const p1 = pagePosts(list, 5, undefined)
  const p2 = pagePosts(list, 5, p1.cursor)
  assert.deepEqual(p2.items.map(p => p.postId), ['14', '13', '12', '11', '10'])
  assert.equal(p2.cursor, '10')
})

test('마지막 페이지: 남은 것만 반환하고 커서 없음', () => {
  const { items, cursor } = pagePosts(list, 50, '4')
  assert.deepEqual(items.map(p => p.postId), ['3', '2', '1', '0'])
  assert.equal(cursor, undefined)
})

test('정확히 끝까지 채운 페이지도 커서를 주지 않는다', () => {
  const { cursor } = pagePosts(list, 20, undefined)
  assert.equal(cursor, undefined)
})

test('새 글이 앞에 끼어도 다음 페이지가 밀리지 않는다', () => {
  const p1 = pagePosts(list, 5, undefined)
  const grown = [{ postId: '20' }, ...list]
  const p2 = pagePosts(grown, 5, p1.cursor)
  assert.deepEqual(p2.items.map(p => p.postId), ['14', '13', '12', '11', '10'])
})

test('커서 게시물이 사라졌으면 그보다 오래된 첫 게시물부터 재개', () => {
  const withoutTen = list.filter(p => p.postId !== '10')
  const { items } = pagePosts(withoutTen, 3, '10')
  assert.deepEqual(items.map(p => p.postId), ['9', '8', '7'])
})

test('빈 리스트·리스트 끝 커서는 빈 페이지', () => {
  assert.deepEqual(pagePosts([], 10, undefined).items, [])
  const { items, cursor } = pagePosts(list, 10, '0')
  assert.deepEqual(items, [])
  assert.equal(cursor, undefined)
})
