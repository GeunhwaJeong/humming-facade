// 결제 멱등층의 계약 검증: 인플라이트 공유, 성공 캐시, 실패 비캐시, 이중 키.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idempotent } from '../lib/idempotency.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
let seq = 0
const uniq = prefix => `${prefix}-${process.pid}-${++seq}`

test('동시 요청은 같은 인플라이트 프라미스를 공유한다 (fn 1회 실행)', async () => {
  const key = uniq('inflight')
  let calls = 0
  const fn = async () => {
    calls++
    await sleep(20)
    return { digest: 'D1' }
  }
  const [a, b] = await Promise.all([
    idempotent(key, 60_000, fn),
    idempotent(key, 60_000, fn),
  ])
  assert.equal(calls, 1)
  assert.equal(a, b)
})

test('성공 결과는 창 안에서 캐시된다', async () => {
  const key = uniq('cache')
  let calls = 0
  const fn = async () => ({ digest: `D${++calls}` })
  const first = await idempotent(key, 60_000, fn)
  const second = await idempotent(key, 60_000, fn)
  assert.equal(calls, 1)
  assert.deepEqual(second, first)
})

test('창이 지나면 다시 실행된다', async () => {
  const key = uniq('window')
  let calls = 0
  const fn = async () => ({ digest: `D${++calls}` })
  await idempotent(key, 10, fn)
  await sleep(30)
  await idempotent(key, 10, fn)
  assert.equal(calls, 2)
})

test('실패는 캐시되지 않는다', async () => {
  const key = uniq('fail')
  let calls = 0
  const fn = async () => {
    if (++calls === 1) throw new Error('boom')
    return { digest: 'D2' }
  }
  await assert.rejects(() => idempotent(key, 60_000, fn))
  const out = await idempotent(key, 60_000, fn)
  assert.equal(out.digest, 'D2')
  assert.equal(calls, 2)
})

test('이중 키: 어느 키로 재시도해도 같은 결과를 받는다', async () => {
  const derived = uniq('derived')
  const header = uniq('hdr')
  let calls = 0
  const fn = async () => ({ digest: `D${++calls}` })
  const keys = [
    { key: derived, windowMs: 60_000 },
    { key: header, windowMs: 60_000 },
  ]
  const first = await idempotent(keys, 60_000, fn)
  // 헤더 키만으로 온 재시도
  const viaHeader = await idempotent([{ key: header, windowMs: 60_000 }], 60_000, fn)
  // 유도 키만으로 온 재시도 (헤더 없는 클라이언트)
  const viaDerived = await idempotent([{ key: derived, windowMs: 60_000 }], 60_000, fn)
  assert.equal(calls, 1)
  assert.deepEqual(viaHeader, first)
  assert.deepEqual(viaDerived, first)
})

test('이중 키: 인플라이트 중에 다른 키로 와도 같은 실행을 공유한다', async () => {
  const derived = uniq('derived2')
  const header = uniq('hdr2')
  let calls = 0
  const fn = async () => {
    calls++
    await sleep(20)
    return { digest: 'DX' }
  }
  const p1 = idempotent([{ key: derived, windowMs: 60_000 }, { key: header, windowMs: 60_000 }], 60_000, fn)
  const p2 = idempotent([{ key: header, windowMs: 60_000 }], 60_000, fn)
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(calls, 1)
  assert.equal(a, b)
})
