// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// 검색 — 계정(핸들·표시 이름)과 게시물 본문의 부분 일치. 인메모리 원장 크기(수천)에서
// 선형 스캔이면 충분하고, 외부 인덱서로 갈 때 이 모듈만 교체한다.
// 순위: 핸들 접두 > 표시 이름 접두 > 부분 일치. 커서는 정렬 결과의 오프셋.
function norm(q) {
  return String(q ?? '').trim().replace(/^@/, '').toLowerCase()
}
function offsetOf(cursor) {
  const n = Number(cursor)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}
function page(list, limit, cursor) {
  const start = offsetOf(cursor)
  const items = list.slice(start, start + limit)
  const next = start + items.length
  return { items, cursor: next < list.length && items.length ? String(next) : undefined }
}

export function searchActors(accounts, q, { limit = 25, cursor } = {}) {
  const needle = norm(q)
  if (!needle) return { items: [], cursor: undefined }
  const ranked = []
  for (const a of accounts) {
    const name = String(a.handle ?? '').toLowerCase().split('.')[0]
    const display = String(a.displayName ?? '').toLowerCase()
    let rank = null
    if (name.startsWith(needle)) rank = 0
    else if (display.startsWith(needle)) rank = 1
    else if (name.includes(needle) || display.includes(needle)) rank = 2
    if (rank !== null) ranked.push({ rank, name, a })
  }
  ranked.sort((x, y) => x.rank - y.rank || x.name.localeCompare(y.name))
  return page(ranked.map(r => r.a), limit, cursor)
}

// items: 게이팅을 거친 게시물 뷰(post.record.text가 뷰어가 볼 수 있는 본문). 잠긴 글은
// 본문이 대체문이라 검색 대상에서 제외한다 — 유료 본문을 검색으로 새게 하지 않는다.
export function searchPosts(items, q, { limit = 25, cursor } = {}) {
  const needle = norm(q)
  if (!needle) return { items: [], cursor: undefined }
  const hits = items.filter(
    it => !it.post?.humming?.locked && String(it.post?.record?.text ?? '').toLowerCase().includes(needle),
  )
  return page(hits, limit, cursor)
}
