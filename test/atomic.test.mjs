// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// writeFileAtomic의 쓰기·교체 계약 검증.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from '../lib/atomic.mjs'

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'humming-atomic-'))

test('신규 파일을 내용 그대로 쓰고 tmp 파일을 남기지 않는다', () => {
  const dir = tmpdir()
  const dest = path.join(dir, 'state.json')
  writeFileAtomic(dest, '{"a":1}')
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"a":1}')
  assert.deepEqual(fs.readdirSync(dir), ['state.json'])
})

test('기존 파일을 완전한 신버전으로 교체한다', () => {
  const dir = tmpdir()
  const dest = path.join(dir, 'state.json')
  writeFileAtomic(dest, 'old-version-longer-content')
  writeFileAtomic(dest, 'new')
  assert.equal(fs.readFileSync(dest, 'utf8'), 'new')
})

test('기본 모드는 0600 (소유자 전용)', () => {
  const dir = tmpdir()
  const dest = path.join(dir, 'secret')
  writeFileAtomic(dest, 'k')
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600)
})

test('mode 옵션이 적용된다', () => {
  const dir = tmpdir()
  const dest = path.join(dir, 'blob')
  writeFileAtomic(dest, 'x', { mode: 0o644 })
  assert.equal(fs.statSync(dest).mode & 0o777, 0o644)
})

test('URL 인자도 받는다', () => {
  const dir = tmpdir()
  const dest = path.join(dir, 'url.json')
  writeFileAtomic(new URL(`file://${dest}`), 'via-url')
  assert.equal(fs.readFileSync(dest, 'utf8'), 'via-url')
})
