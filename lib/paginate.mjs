// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// XRPC 커서 페이지네이션 (순수 함수, 단위 테스트 대상).
// 피드 목록은 최신순(post_id 내림차순)으로 안정 정렬돼 있고, 커서는 "직전 페이지
// 마지막 게시물의 postId"다. 오프셋 커서와 달리 새 글이 앞에 끼어들어도 다음
// 페이지가 밀리거나 중복되지 않는다. 클라이언트에게 커서는 불투명 문자열이다.

export function clampLimit(raw, def = 50, max = 100) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), max)
}

// list: {postId} 배열(내림차순), cursor: 직전 페이지 마지막 postId 또는 없음.
// 반환 cursor는 다음 페이지가 있을 때만 존재한다.
export function pagePosts(list, limit, cursor) {
  let start = 0
  if (cursor != null && cursor !== '') {
    const i = list.findIndex(p => p.postId === String(cursor))
    if (i >= 0) start = i + 1
    else {
      // 커서 게시물이 사라진 경우(리인덱스 등): 그보다 오래된 첫 게시물부터 재개
      const c = Number(cursor)
      if (Number.isFinite(c)) {
        start = list.findIndex(p => Number(p.postId) < c)
        if (start < 0) start = list.length
      }
    }
  }
  const items = list.slice(start, start + limit)
  const hasMore = start + items.length < list.length
  return {
    items,
    cursor: hasMore && items.length ? items[items.length - 1].postId : undefined,
  }
}
