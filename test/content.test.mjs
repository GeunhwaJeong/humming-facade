// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// content_uri 인코딩·디코딩 — 미디어·언어·셀프 라벨 마커의 왕복과 하위 호환.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeContent, decodeContent, cleanSelfLabels, SELF_LABEL_VALUES } from '../lib/content.mjs'

const media = [{ cid: 'bafkreiabc', mime: 'image/jpeg', w: 640, h: 480 }]

test('라벨은 언어 뒤에 붙고 왕복이 보존된다', () => {
  const enc = encodeContent('hello', media, ['ko', 'en'], { values: [{ val: 'porn' }, { val: 'nudity' }] })
  assert.ok(enc.endsWith(' §labels:porn,nudity'))
  const dec = decodeContent(enc)
  assert.equal(dec.text, 'hello')
  assert.deepEqual(dec.media, media)
  assert.deepEqual(dec.langs, ['ko', 'en'])
  assert.deepEqual(dec.labels, ['porn', 'nudity'])
})

test('라벨 없는 과거 글은 빈 라벨로 읽힌다 (하위 호환)', () => {
  const dec = decodeContent('old post §media:bafkreiabc~image_jpeg~1x1 §langs:ko')
  assert.equal(dec.text, 'old post')
  assert.deepEqual(dec.langs, ['ko'])
  assert.deepEqual(dec.labels, [])
  assert.deepEqual(decodeContent('plain'), { text: 'plain', media: [], langs: [], labels: [] })
})

test('허용 목록 밖의 라벨 값은 버리고 중복은 접는다', () => {
  assert.deepEqual(cleanSelfLabels({ values: [{ val: 'porn' }, { val: 'porn' }, { val: 'spam' }, { val: '!hide' }] }), ['porn'])
  assert.deepEqual(cleanSelfLabels(['sexual', 'graphic-media', 42, null]), ['sexual', 'graphic-media'])
  assert.deepEqual(cleanSelfLabels(undefined), [])
  assert.deepEqual(cleanSelfLabels('porn'), [])
  for (const v of SELF_LABEL_VALUES) assert.deepEqual(cleanSelfLabels([v]), [v])
})

test('본문에 마커 문자열이 있어도 뒤쪽 마커부터 벗겨 오염되지 않는다', () => {
  const enc = encodeContent('a §labels:porn in text', [], [], ['sexual'])
  const dec = decodeContent(enc)
  assert.deepEqual(dec.labels, ['sexual'])
  assert.equal(dec.text, 'a §labels:porn in text')
})
