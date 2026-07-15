// 파사드 업그레이드 검증 — SDK 서명 경로 + 인덱서 게이팅 풀 플로우
const F = 'http://localhost:3025/xrpc'
const j = async (r) => {
  const body = await r.json()
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body)}`)
  return body
}
const post = (nsid, body, jwt) =>
  fetch(`${F}/${nsid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jwt && { Authorization: `Bearer ${jwt}` }) },
    body: JSON.stringify(body),
  }).then(j)
const get = (nsid, params, jwt) =>
  fetch(`${F}/${nsid}?${new URLSearchParams(params)}`, {
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
  }).then(j)
const login = async (identifier) =>
  (await post('com.atproto.server.createSession', { identifier, password: 'humming' })).accessJwt
const ok = (label, cond, detail = '') => {
  if (!cond) throw new Error(`FAIL: ${label} ${detail}`)
  console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. bob: 크리에이터 전환 (1 HANEUL/30일, open)
const bob = await login('bob.hum.haneul')
const bc1 = await post('app.humming.creator.becomeCreator',
  { priceGeunhwa: 1_000_000_000, periodDays: 30, lockMode: 'open' }, bob)
ok('bob becomeCreator', !!bc1.digest, `tx=${bc1.digest.slice(0, 12)}…`)

// 2. carol: 크리에이터 전환 (0.5 HANEUL/30일, 전면 잠금)
const carol = await login('carol.hum.haneul')
const bc2 = await post('app.humming.creator.becomeCreator',
  { priceGeunhwa: 500_000_000, periodDays: 30, lockMode: 'lock' }, carol)
ok('carol becomeCreator(lock)', !!bc2.digest)

// 3. bob: 공개 글 — 큰따옴표/역슬래시 포함 (sanitizeText 제거 검증)
const TRICKY = 'Humming "온체인" 첫 글 — backslash \\ 그대로!'
const p1 = await post('com.atproto.repo.createRecord', {
  repo: 'did:web:bob.hum.haneul', collection: 'app.bsky.feed.post',
  record: { $type: 'app.bsky.feed.post', text: TRICKY, createdAt: new Date().toISOString() },
}, bob)
ok('bob 공개 글', !!p1.uri, p1.uri)

// 4. bob: 유료 글 (0.5 HANEUL 페이월, 글+가격 원자 확정)
const p2 = await post('com.atproto.repo.createRecord', {
  repo: 'did:web:bob.hum.haneul', collection: 'app.bsky.feed.post',
  record: {
    $type: 'app.bsky.feed.post', text: '구독자 전용 프리미엄 글 🐝', createdAt: new Date().toISOString(),
    humming: { paywallGeunhwa: 500_000_000 },
  },
}, bob)
const paidPostId = p2.uri.split('/').pop()
ok('bob 유료 글', !!p2.uri, `post ${paidPostId}`)

// 5. carol: 잠금 프로필 글
const p3 = await post('com.atproto.repo.createRecord', {
  repo: 'did:web:carol.hum.haneul', collection: 'app.bsky.feed.post',
  record: { $type: 'app.bsky.feed.post', text: 'carol의 구독자 전용 정원 🌱', createdAt: new Date().toISOString() },
}, carol)
ok('carol 글', !!p3.uri)

// 6. 신규 가입 = 닉네임 = 지갑 (SDK 인프로세스 키 생성 + faucet + new_leaf)
const su = await post('com.atproto.server.createAccount', { handle: 'mina.hum.haneul', password: 'humming' })
ok('mina 가입', su.did === 'did:web:mina.hum.haneul')
const rh = await get('com.atproto.identity.resolveHandle', { handle: 'mina.hum.haneul' })
ok('mina 온체인 이름 해석', rh.did === 'did:web:mina.hum.haneul')
// 중복 가입 400 거부
const dup = await fetch(`${F}/com.atproto.server.createAccount`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ handle: 'mina.hum.haneul', password: 'x' }),
})
ok('중복 가입 400 거부', dup.status === 400)

// 7. mina: bob 구독 → 유료 글 열림
const mina = su.accessJwt
const sub = await post('app.humming.monetization.subscribe', { creator: 'bob.hum.haneul' }, mina)
ok('mina→bob 구독', !!sub.digest, `${sub.priceGeunhwa / 1e9} HANEUL`)
const tlMina = await get('app.bsky.feed.getTimeline', {}, mina)
const paidForMina = tlMina.feed.find(f => f.post.uri.endsWith(`/${paidPostId}`))
ok('구독자에게 유료 글 열림', paidForMina && !paidForMina.post.humming?.locked,
  JSON.stringify(paidForMina?.post.record.text).slice(0, 40))
const carolForMina = tlMina.feed.find(f => f.post.record.text?.includes?.('정원') || f.post.humming?.reason === 'profile')
ok('비구독 carol 글은 잠김', carolForMina?.post.humming?.locked === true)

// 8. 익명(비구독) 뷰어에게 유료 글 잠김 + 본문 원문 노출 확인
const tlAnon = await get('app.bsky.feed.getTimeline', {})
const paidAnon = tlAnon.feed.find(f => f.post.uri.endsWith(`/${paidPostId}`))
ok('비구독자에게 유료 글 잠김', paidAnon?.post.humming?.locked === true)
const openAnon = tlAnon.feed.find(f => f.post.record.text === TRICKY)
ok('따옴표·역슬래시 본문 원문 보존', !!openAnon, '(sanitize 제거 검증)')

// 9. erin: PPV 단건 구매 + 팁
const erin = await login('erin.hum.haneul')
const buy = await post('app.humming.monetization.purchasePost', { postId: paidPostId }, erin)
ok('erin PPV 구매', !!buy.digest)
const tip = await post('app.humming.monetization.tip',
  { creator: 'bob.hum.haneul', postId: paidPostId, amountGeunhwa: 200_000_000 }, erin)
ok('erin 팁 0.2 HANEUL', !!tip.digest)
const tlErin = await get('app.bsky.feed.getTimeline', {}, erin)
const paidErin = tlErin.feed.find(f => f.post.uri.endsWith(`/${paidPostId}`))
ok('구매자에게 유료 글 열림', paidErin && !paidErin.post.humming?.locked)

// 10. bob 수익 대시보드 — 인덱서 원장 합산 (구독 0.95 + PPV 0.475 + 팁 0.19 = 1.615)
const earn = await get('app.humming.creator.getEarnings', {}, bob)
const expect = 950_000_000 + 475_000_000 + 190_000_000
ok('bob 수익 합산', earn.totals.totalGeunhwa === expect,
  `${earn.totals.totalGeunhwa / 1e9} HANEUL (구독 ${earn.totals.subscriptionGeunhwa / 1e9} + PPV ${earn.totals.purchaseGeunhwa / 1e9} + 팁 ${earn.totals.tipGeunhwa / 1e9})`)

// 11. 병렬성: 서로 다른 두 지갑이 carol을 동시 구독 (구 코드에선 전역 직렬)
const alice = await login('alice.hum.haneul')
const dave = await login('dave.hum.haneul')
const t0 = Date.now()
const [s1, s2] = await Promise.all([
  post('app.humming.monetization.subscribe', { creator: 'carol.hum.haneul' }, alice),
  post('app.humming.monetization.subscribe', { creator: 'carol.hum.haneul' }, dave),
])
ok('동시 구독 2건 성공', !!s1.digest && !!s2.digest, `${Date.now() - t0}ms, tx ${s1.digest.slice(0, 8)}/${s2.digest.slice(0, 8)}`)

console.log('\n🎉 전 항목 통과')
