// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mediaOwners } from '../lib/media.mjs'

test('mediaOwners lists the first uploader and every later uploader of the same bytes', () => {
  assert.deepEqual(mediaOwners({ owner: '0xa', uploaders: ['0xb', '0xc', '0xa'] }), ['0xa', '0xb', '0xc'])
  assert.deepEqual(mediaOwners({ owner: '0xa' }), ['0xa'])
})

test('mediaOwners is null when the meta names nobody, so the chain fallback applies', () => {
  assert.equal(mediaOwners({}), null)
  assert.equal(mediaOwners(null), null)
  assert.equal(mediaOwners({ owner: '', uploaders: [] }), null)
})
