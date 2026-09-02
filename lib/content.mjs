// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// content_uri 인코딩 — 본문 뒤에 미디어 포인터·언어 태그·셀프 라벨을 덧붙인다.
// 형식: <text>[ §media:...][ §langs:ko,en][ §labels:porn,sexual]
// 마커는 항상 이 순서로 뒤에 오고, 디코드는 뒤쪽 마커부터 벗겨 낸다. 과거에 기록된
// 글(라벨 마커 없음)은 라벨 없는 글로 읽힌다.
const MEDIA_MARK = ' §media:'
const LANGS_MARK = ' §langs:'
const LABELS_MARK = ' §labels:'

// BCP-47 형태만 통과 (컴포저 언어 선택값), 최대 3개 — ATProto post.langs 상한과 동일
export function cleanLangs(langs) {
  if (!Array.isArray(langs)) return []
  return langs
    .filter(l => typeof l === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(l))
    .slice(0, 3)
}

// 컴포저의 "콘텐츠 경고"가 붙일 수 있는 셀프 라벨 — Bluesky 앱이 내장 정의로 블러·숨김을
// 적용하는 전역 값들. 이 밖의 값은 앱이 해석 못 하므로 저장하지 않는다.
export const SELF_LABEL_VALUES = ['porn', 'sexual', 'nudity', 'graphic-media']

// record.labels(com.atproto.label.defs#selfLabels) 또는 문자열 배열 → 허용 값만, 중복 제거
export function cleanSelfLabels(labels) {
  const raw = Array.isArray(labels) ? labels : Array.isArray(labels?.values) ? labels.values : []
  const out = []
  for (const l of raw) {
    const val = typeof l === 'string' ? l : l?.val
    if (SELF_LABEL_VALUES.includes(val) && !out.includes(val)) out.push(val)
  }
  return out
}

export function encodeContent(text, media, langs, labels) {
  let t = text || ''
  if (media?.length)
    t +=
      MEDIA_MARK +
      media.map(m => `${m.cid}~${m.mime.replace('/', '_')}~${m.w}x${m.h}`).join(',')
  const ls = cleanLangs(langs)
  if (ls.length) t += LANGS_MARK + ls.join(',')
  const lb = cleanSelfLabels(labels)
  if (lb.length) t += LABELS_MARK + lb.join(',')
  return t
}

export function decodeContent(raw) {
  let rest = raw || ''
  let labels = []
  const bi = rest.lastIndexOf(LABELS_MARK)
  if (bi >= 0) {
    labels = cleanSelfLabels(rest.slice(bi + LABELS_MARK.length).split(','))
    rest = rest.slice(0, bi)
  }
  let langs = []
  const li = rest.lastIndexOf(LANGS_MARK)
  if (li >= 0) {
    langs = cleanLangs(rest.slice(li + LANGS_MARK.length).split(','))
    rest = rest.slice(0, li)
  }
  const i = rest.indexOf(MEDIA_MARK)
  if (i < 0) return { text: rest, media: [], langs, labels }
  const media = rest
    .slice(i + MEDIA_MARK.length)
    .split(',')
    .map(s => {
      const [cid, mime, dims] = s.split('~')
      const [w, h] = (dims || '').split('x').map(Number)
      return { cid, mime: (mime || 'image_jpeg').replace('_', '/'), w: w || 0, h: h || 0 }
    })
    .filter(m => m.cid)
  return { text: rest.slice(0, i), media, langs, labels }
}
