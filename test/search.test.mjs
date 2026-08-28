// 계정·게시물 검색의 순위·커서·잠금 제외.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchActors, searchPosts } from '../lib/search.mjs'

const accounts = [
  { handle: 'sora.hum.haneul', displayName: 'Sora ✨' },
  { handle: 'mina.hum.haneul', displayName: 'sorapop' },
  { handle: 'yuna.hum.haneul', displayName: 'Best of Sora' },
  { handle: 'bob.hum.haneul', displayName: 'Bob' },
]

test('핸들 접두 > 표시 이름 접두 > 부분 일치 순으로 정렬한다', () => {
  const { items } = searchActors(accounts, 'sora')
  assert.deepEqual(items.map(a => a.handle.split('.')[0]), ['sora', 'mina', 'yuna'])
})

test('@와 대소문자·공백을 무시하고, 빈 질의는 빈 결과', () => {
  assert.equal(searchActors(accounts, ' @SORA ').items.length, 3)
  assert.equal(searchActors(accounts, '').items.length, 0)
  assert.equal(searchActors(accounts, '   ').items.length, 0)
  assert.equal(searchActors(accounts, 'zzz').items.length, 0)
})

test('커서는 오프셋이고 마지막 페이지엔 커서가 없다', () => {
  const p1 = searchActors(accounts, 'sora', { limit: 2 })
  assert.equal(p1.items.length, 2)
  assert.equal(p1.cursor, '2')
  const p2 = searchActors(accounts, 'sora', { limit: 2, cursor: p1.cursor })
  assert.deepEqual(p2.items.map(a => a.handle.split('.')[0]), ['yuna'])
  assert.equal(p2.cursor, undefined)
})

test('게시물 검색은 본문 부분 일치, 잠긴 글은 제외', () => {
  const items = [
    { postId: '3', post: { record: { text: 'Hello Humming world' } } },
    { postId: '2', post: { record: { text: 'secret humming drop' }, humming: { locked: true } } },
    { postId: '1', post: { record: { text: 'unrelated' } } },
  ]
  const r = searchPosts(items, 'HUMMING')
  assert.deepEqual(r.items.map(i => i.postId), ['3'])
  assert.equal(searchPosts(items, '').items.length, 0)
})
