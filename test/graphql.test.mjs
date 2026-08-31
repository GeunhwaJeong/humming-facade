import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toIndexerEvent, shouldBackfill, fetchGapEvents } from '../lib/graphql.mjs'

const PKG = '0x' + 'ab'.repeat(32)
const node = (seq, digest, cp, ts, type = `${PKG}::tips::TipSent`, json = { amount: '5' }) => ({
  sequenceNumber: seq,
  timestamp: ts,
  contents: { type: { repr: type }, json },
  transaction: { digest, effects: { checkpoint: { sequenceNumber: String(cp) } } },
})

test('toIndexerEvent produces the stream/journal vocabulary with the tx-local event index as eventSeq', () => {
  const ev = toIndexerEvent(node('2', 'D1', 100, '2026-08-28T08:04:44.367Z'))
  assert.deepEqual(ev.id, { txDigest: 'D1', eventSeq: '2' })
  assert.equal(ev.type, `${PKG}::tips::TipSent`)
  assert.deepEqual(ev.parsedJson, { amount: '5' })
  assert.equal(ev.timestampMs, Date.parse('2026-08-28T08:04:44.367Z'))
  assert.equal(ev.checkpoint, 100)
})

test('shouldBackfill needs both a configured URL and a gap at least the threshold', () => {
  assert.equal(shouldBackfill(1000, { url: 'https://x/graphql', min: 300 }), true)
  assert.equal(shouldBackfill(299, { url: 'https://x/graphql', min: 300 }), false)
  assert.equal(shouldBackfill(1000, { url: null, min: 300 }), false)
})

test('fetchGapEvents queries every type with exclusive bounds, follows pagination, and returns chain order', async () => {
  const calls = []
  const TYPES = [`${PKG}::feed::PostCreated`, `${PKG}::feed::PostDeleted`, `${PKG}::tips::TipSent`]
  const pages = {
    [TYPES[0]]: [
      { nodes: [node('0', 'T2', 12, '2026-01-01T00:00:02Z', TYPES[0])], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
      { nodes: [node('1', 'T3', 12, '2026-01-01T00:00:02Z', TYPES[0])], pageInfo: { hasNextPage: false, endCursor: null } },
    ],
    [TYPES[2]]: [
      { nodes: [node('0', 'T1', 11, '2026-01-01T00:00:01Z')], pageInfo: { hasNextPage: false, endCursor: null } },
    ],
  }
  const fetchImpl = async (url, init) => {
    const { variables } = JSON.parse(init.body)
    calls.push(variables)
    const list = pages[variables.f.type] ?? [{ nodes: [], pageInfo: { hasNextPage: false } }]
    const page = variables.after ? list[1] : list[0]
    return { ok: true, json: async () => ({ data: { events: page } }) }
  }
  const events = await fetchGapEvents(1000, 1500, TYPES, { url: 'https://x/graphql', fetchImpl })
  assert.equal(calls.length, TYPES.length + 1) // one per type plus the second PostCreated page
  for (const v of calls) {
    assert.equal(v.f.afterCheckpoint, 1000)
    assert.equal(v.f.beforeCheckpoint, 1501)
  }
  assert.equal(calls.filter(v => v.after === 'c1').length, 1)
  assert.deepEqual(
    events.map(e => `${e.checkpoint}:${e.id.txDigest}:${e.id.eventSeq}`),
    ['11:T1:0', '12:T2:0', '12:T3:1'],
  )
})

test('fetchGapEvents surfaces GraphQL errors instead of returning a partial gap', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'boom' }] }) })
  await assert.rejects(fetchGapEvents(1, 2, [`${PKG}::tips::TipSent`], { url: 'https://x/graphql', fetchImpl }), /GraphQL: boom/)
  await assert.rejects(fetchGapEvents(1, 2, [`${PKG}::tips::TipSent`], { url: null, fetchImpl }), /not configured/)
  await assert.rejects(fetchGapEvents(1, 2, [], { url: 'https://x/graphql', fetchImpl }), /No event types/)
})
