// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// 미디어 소유권 — 업로드 meta.json 한 건이 인정하는 계정 집합.
// owner는 최초 업로더(쿼터 귀속 주체), uploaders는 같은 바이트를 나중에 올린 계정들.
// 둘 다 "바이트를 실제로 가진 계정"이므로 서명 URL 발급 대상이다. 공개된 CID 문자열만
// 아는 계정은 어느 쪽에도 들지 못한다.
export function mediaOwners(meta) {
  if (!meta || typeof meta !== 'object') return null
  const out = []
  if (typeof meta.owner === 'string' && meta.owner) out.push(meta.owner)
  for (const u of Array.isArray(meta.uploaders) ? meta.uploaders : []) {
    if (typeof u === 'string' && u && !out.includes(u)) out.push(u)
  }
  return out.length ? out : null
}
