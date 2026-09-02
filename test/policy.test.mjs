// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// 입력 정책(비밀번호·MIME·상수시간 비교) 검증.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkNewPassword, MIN_PASSWORD_LENGTH,
  isAllowedMediaMime, safeEqual,
  MAX_POST_TEXT_CHARS, MAX_APPLY_WRITES,
} from '../lib/policy.mjs'

test('짧은 비밀번호는 거부한다', () => {
  assert.notEqual(checkNewPassword('abc'), null)
  assert.notEqual(checkNewPassword('1234567'), null)
  assert.notEqual(checkNewPassword(''), null)
  assert.notEqual(checkNewPassword(undefined), null)
})

test('흔한 비밀번호는 길이가 충분해도 거부한다 (대소문자 무시)', () => {
  assert.notEqual(checkNewPassword('password123'), null)
  assert.notEqual(checkNewPassword('Password123'), null)
  assert.notEqual(checkNewPassword('qwertyuiop'), null)
  assert.notEqual(checkNewPassword('iloveyou1'), null)
})

test('정상 비밀번호는 통과한다', () => {
  assert.equal(checkNewPassword('correct-horse-battery'), null)
  assert.equal(checkNewPassword('humming-fan-4ever'), null)
  // 정확히 최소 길이(8자)인 비흔한 비밀번호도 통과
  assert.equal(checkNewPassword('xk29fmq1'.slice(0, MIN_PASSWORD_LENGTH)), null)
})

test('MIME 화이트리스트: 이미지·비디오만 통과', () => {
  assert.ok(isAllowedMediaMime('image/png'))
  assert.ok(isAllowedMediaMime('image/jpeg'))
  assert.ok(isAllowedMediaMime('video/mp4'))
  assert.ok(isAllowedMediaMime('IMAGE/PNG')) // 대소문자 무시
  assert.ok(isAllowedMediaMime('image/png; charset=utf-8')) // 파라미터 무시
  assert.ok(!isAllowedMediaMime('text/html'))
  assert.ok(!isAllowedMediaMime('application/octet-stream'))
  assert.ok(!isAllowedMediaMime('audio/mpeg')) // 앱에 오디오 업로드 경로 없음
  assert.ok(!isAllowedMediaMime('image/svg+xml')) // 스크립트 실행 가능한 XML
  assert.ok(!isAllowedMediaMime(''))
  assert.ok(!isAllowedMediaMime(undefined))
  assert.ok(!isAllowedMediaMime('image/')) // 서브타입 없는 형태
})

test('safeEqual: 길이가 다르면 던지지 않고 false', () => {
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual('', 'a'), false)
})

test('safeEqual: 동등·불일치 판정', () => {
  assert.equal(safeEqual('sig-value', 'sig-value'), true)
  assert.equal(safeEqual('sig-value', 'sig-valuX'), false)
  assert.equal(safeEqual(undefined, ''), true) // 결측은 빈 문자열로 정규화
  assert.equal(safeEqual(null, 'x'), false)
})

test('길이 상한 상수의 방향성', () => {
  // 앱의 300 grapheme 상한을 서버 문자 상한이 항상 포용해야 한다
  assert.ok(MAX_POST_TEXT_CHARS >= 300)
  assert.ok(MAX_APPLY_WRITES >= 1)
})
