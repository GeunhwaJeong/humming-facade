// Humming XRPC Facade — serves the Bluesky app from the Haneul chain.
// The app speaks ATProto XRPC; we answer from humming contract events on localnet.
import express from 'express'
import cors from 'cors'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const PORT = 3025
const RPC = 'http://127.0.0.1:9000'
const PKG = '0x49082d2bdac8d4a0bb16ef0abdee252b926a56b2e4f8aa87000900d74d8ed5cc'
const FEED = '0x139a5d29d3fde7b6c975ad6ccc29e0c16c59d75f8f39dfb6c4fb98cbc68feaad'
const RULES = '0xf2fc4735918ba0bf9944585af2223a47ba93c3727bc50b7df3d7b07f3a44d9cb'
const FEE_CONFIG = '0x3e2ad3ddeb71f3d9623a236892f71c6d4d9825c55611fa492eed879f44481e44'
// creator_prefs 공유 레지스트리 — 설정 쓰기 PTB에만 필요 (읽기는 이벤트로)
const PREFS_REGISTRY = '0x6779c778ddb6a1173569d23ddb1a8628e1ad02c8569869409c75e6990f7a94df'
const HANEUL_TYPE = '0x2::haneul::HANEUL'
const CLI = '/Users/jeong-gh/haneul/target/release/haneul'

// ---- haneulns (온체인 네임서비스) — 가입 = 닉네임 = 지갑 ----
// 가입 시 hum.haneul 부모 NFT로 leaf 서브네임을 발급 (수수료·NFT 없음, 앱이 가스 대납)
const NS_PKG = '0xb4d93ff579dfaab8a07d959a687711cbd09fae06ac44f6e34521d45727a36a11'
const NS_SUB_PKG = '0x02a625583d4c7c246a1561408824c881ffca8604681f7d4c3a86425e5cb039ef'
const NS_OBJ = '0x594a4dbedce19110d77403646f17760eac203ba3594f78cca910faf020323338'
const HUM_PARENT_NFT = '0xd2b869e28713b6e1370466b42f0aaa547d6eab66e19bacaed1af1132f5c7210c'
const APP_WALLET = '0x7e6dc9a774eb022d809e3ab7e5d578126e98e5e351f07aee820951dd2b80c3de'

// ---- 미디어 저장소: 콘텐츠는 오프체인, 체인에는 CID 포인터만 ----
// 파일 삭제 = 콘텐츠 삭제 가능(법적 요건), 체인의 CID는 존재 증명만 남음
const MEDIA_DIR = '/Users/jeong-gh/humming-facade/media'
fs.mkdirSync(MEDIA_DIR, { recursive: true })
// 서명 비밀키는 프로세스 수명 — URL은 요청마다 새로 발급되므로 재시작 무해
const MEDIA_SECRET = crypto.randomBytes(32)
const MEDIA_URL_TTL_MS = 15 * 60 * 1000
const signMedia = (cid, exp) =>
  crypto.createHmac('sha256', MEDIA_SECRET).update(`${cid}:${exp}`).digest('base64url')
// 열람 자격이 확인된 응답에만 실리는 만료형 서명 URL
function mediaUrl(cid) {
  const exp = Date.now() + MEDIA_URL_TTL_MS
  return `http://localhost:${PORT}/media/${cid}?exp=${exp}&sig=${signMedia(cid, exp)}`
}

// content_uri 인코딩: 본문 뒤에 따옴표 없는 미디어 포인터를 덧붙임
// (PTB 문자열이 큰따옴표를 못 품는 제약과 호환되는 포맷)
const MEDIA_MARK = ' §media:'
function encodeContent(text, media) {
  const t = sanitizeText(text)
  if (!media?.length) return t
  return (
    t +
    MEDIA_MARK +
    media.map(m => `${m.cid}~${m.mime.replace('/', '_')}~${m.w}x${m.h}`).join(',')
  )
}
function decodeContent(raw) {
  const i = (raw || '').indexOf(MEDIA_MARK)
  if (i < 0) return { text: raw || '', media: [] }
  const media = raw
    .slice(i + MEDIA_MARK.length)
    .split(',')
    .map(s => {
      const [cid, mime, dims] = s.split('~')
      const [w, h] = (dims || '').split('x').map(Number)
      return { cid, mime: (mime || 'image_jpeg').replace('_', '/'), w: w || 0, h: h || 0 }
    })
    .filter(m => m.cid)
  return { text: raw.slice(0, i), media }
}

function imagesEmbedView(media) {
  const images = (media || []).filter(m => m.mime.startsWith('image/'))
  if (!images.length) return undefined
  return {
    $type: 'app.bsky.embed.images#view',
    images: images.map(m => ({
      thumb: mediaUrl(m.cid),
      fullsize: mediaUrl(m.cid),
      alt: '',
      ...(m.w && m.h ? { aspectRatio: { width: m.w, height: m.h } } : {}),
    })),
  }
}
const mediaCounts = media => ({
  images: (media || []).filter(m => m.mime.startsWith('image/')).length,
  videos: (media || []).filter(m => m.mime.startsWith('video/')).length,
})

// ---- identity: haneulns-style handles mapped to Haneul addresses ----
const ACCOUNTS = [
  {
    handle: 'bob.hum.haneul',
    did: 'did:web:bob.hum.haneul',
    address: '0x8af0079f1c61849b3c5563ba123ed5413fcc05c8963fd0ecf81bd8220b067014',
    displayName: 'Bob 🐝',
    description: 'Humming 크리에이터 — 이 프로필은 Haneul 온체인 데이터입니다',
    password: 'humming',
    // 크리에이터 신원·연령 인증 완료 (실서비스에선 KYC 절차 통과가 조건)
    verified: true,
  },
  {
    handle: 'alice.hum.haneul',
    did: 'did:web:alice.hum.haneul',
    address: '0xa5a8018f9eea5421ff6e9001bb0b8b502e5dd8d40265c38b728c3a1f5e5cf3f0',
    displayName: 'Alice ✨',
    description: 'Humming 첫 구독자',
    password: 'humming',
  },
  {
    // 전면 잠금 크리에이터 — 게시물 전체가 구독자 전용 (OnlyFans 스타일)
    handle: 'carol.hum.haneul',
    did: 'did:web:carol.hum.haneul',
    address: '0x721790f36e8ae1c71849c5b9897b2a9a150015da1ca37be20f74fbdea4580103',
    displayName: 'Carol 🌱',
    description: '구독자 전용 프로필 — 모든 게시물이 구독으로 열립니다',
    password: 'humming',
    verified: true,
    // 프로필 잠금 설정은 온체인(creator_prefs) — carol이 직접 서명해 설정함
  },
  {
    // 미디어 페이월 시연용 신규 팬 — 아무도 구독하지 않은 상태
    handle: 'dave.hum.haneul',
    did: 'did:web:dave.hum.haneul',
    address: '0xff8a26d90d7061bc2ec49849e69caf04047944bc53b41abc6d3586eec90f9da9',
    displayName: 'Dave 🎧',
    description: 'Humming 신규 유저',
    password: 'humming',
  },
  {
    // 단건 구매(PPV) 시연용 — 어떤 구독도 하지 않은 상태 유지
    handle: 'erin.hum.haneul',
    did: 'did:web:erin.hum.haneul',
    address: '0x454b30d5ca6c69048cf050368d3bf3c75fd7ed32427ac1c24b9d696dba9bd1a7',
    displayName: 'Erin 🌊',
    description: 'Humming 신규 유저',
    password: 'humming',
  },
]
const byHandle = h => ACCOUNTS.find(a => a.handle === h || a.did === h)
const byAddress = addr => ACCOUNTS.find(a => a.address === addr)
const byDid = d => ACCOUNTS.find(a => a.did === d)

// 가입으로 생긴 계정은 accounts.json으로 존속 (재시작 생존; 시드 계정과 병합)
const ACCOUNTS_FILE = new URL('./accounts.json', import.meta.url)
try {
  for (const a of JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))) {
    if (!ACCOUNTS.some(x => x.handle === a.handle)) ACCOUNTS.push(a)
  }
} catch {}
const persistAccounts = () =>
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(ACCOUNTS.filter(a => a.signup), null, 2))

// ---- haneulns 온체인 이름 해석 ----
// HaneulNS 공유 객체 → RegistryKey df → Registry.registry 테이블 ID (부팅 후 1회 조회)
let nsRegistryTable = null
function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined
  if (obj[key] !== undefined) return obj[key]
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key)
    if (found !== undefined) return found
  }
  return undefined
}
async function getNsRegistryTable() {
  if (nsRegistryTable) return nsRegistryTable
  const dfs = await rpc('haneulx_getDynamicFields', [NS_OBJ, null, 20])
  const reg = dfs.data.find(d => (d.name?.type || '').includes('::haneulns::RegistryKey<'))
  const obj = await rpc('haneul_getObject', [reg.objectId, { showContent: true }])
  nsRegistryTable = deepFind(obj.data.content.fields, 'registry').fields.id.id
  return nsRegistryTable
}
// 'grace.hum.haneul' → 레지스트리 테이블에서 NameRecord 조회 (labels는 TLD-first)
async function chainNameRecord(handle) {
  const labels = String(handle || '').toLowerCase().split('.').reverse()
  if (labels.length < 2 || labels[0] !== 'haneul') return null
  try {
    const table = await getNsRegistryTable()
    const res = await rpc('haneulx_getDynamicFieldObject', [
      table,
      { type: `${NS_PKG}::domain::Domain`, value: { labels } },
    ])
    const fields = deepFind(res, 'target_address') !== undefined ? res : null
    if (!fields) return null
    return { target: deepFind(res, 'target_address') }
  } catch {
    return null
  }
}

// ---- fake-but-wellformed JWTs (the app never verifies signatures) ----
const b64u = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
function makeJwt(did, scope) {
  const now = Math.floor(Date.now() / 1000)
  return [
    b64u({ typ: 'JWT', alg: 'HS256' }),
    b64u({ scope, sub: did, aud: 'did:web:localhost', iat: now, exp: now + 60 * 60 * 24 * 365 }),
    'humming-facade-sig',
  ].join('.')
}
function didFromAuth(req) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '')
  try {
    return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).sub
  } catch {
    return null
  }
}

// ---- Haneul JSON-RPC ----
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`)
  return json.result
}

// ---- chain → lexicon mapping ----
async function fakeCid(seed) {
  // deterministic, structurally valid CIDv1 (dag-cbor + sha2-256) — the app parses cids for real
  const digest = await sha256.digest(new TextEncoder().encode(seed))
  return CID.createV1(0x71, digest).toString()
}

function profileBasic(acct) {
  return {
    did: acct.did,
    handle: acct.handle,
    displayName: acct.displayName,
    labels: [],
    createdAt: '2026-07-10T00:00:00.000Z',
    viewer: { muted: false, blockedBy: false },
    // 신원 인증 완료 크리에이터는 이름 옆에 배지 — 앱 내장 verification 시스템이 렌더
    ...(acct.verified && {
      verification: {
        verifications: [
          {
            issuer: 'did:web:humming.haneul',
            issuerDisplayName: 'Humming',
            uri: `at://did:web:humming.haneul/app.bsky.graph.verification/${acct.handle.split('.')[0]}`,
            isValid: true,
            createdAt: '2026-07-10T00:00:00.000Z',
          },
        ],
        verifiedStatus: 'valid',
        trustedVerifierStatus: 'none',
      },
    }),
  }
}

let postCache = []
async function loadPosts() {
  const result = await rpc('haneulx_queryEvents', [
    { MoveEventType: `${PKG}::feed::PostCreated` },
    null,
    50,
    true, // newest first
  ])
  const mapped = await Promise.all(
    result.data.map(async ev => {
      const p = ev.parsedJson
      const acct = byAddress(p.author)
      if (!acct) return null
      const createdAt = new Date(Number(ev.timestampMs)).toISOString()
      const { text, media } = decodeContent(p.content_uri)
      return {
        postId: p.post_id,
        repliedTo: p.replied_to,
        author: acct,
        media,
        post: {
          uri: `at://${acct.did}/app.bsky.feed.post/${p.post_id}`,
          cid: await fakeCid(ev.id.txDigest),
          author: profileBasic(acct),
          record: {
            $type: 'app.bsky.feed.post',
            text,
            createdAt,
            langs: ['ko'],
          },
          // 서명 URL은 게이팅 통과 응답에만 남음 — gatePosts가 비자격자에게서 제거
          ...(media.length ? { embed: imagesEmbedView(media) } : {}),
          replyCount: 0,
          repostCount: 0,
          likeCount: 0,
          quoteCount: 0,
          bookmarkCount: 0,
          indexedAt: createdAt,
          viewer: { threadMuted: false, embeddingDisabled: false },
          labels: [],
        },
      }
    }),
  )
  postCache = mapped.filter(Boolean)
  // reply counts
  for (const item of postCache) {
    if (item.repliedTo != null) {
      const parent = postCache.find(x => x.postId === String(item.repliedTo))
      if (parent) parent.post.replyCount++
    }
  }
  return postCache
}

// ---- paywall & subscription state — 매 요청 체인 이벤트에서 재구성 ----
async function loadGateState() {
  const q = type => rpc('haneulx_queryEvents', [{ MoveEventType: `${PKG}::${type}` }, null, 50, true])
  const [pay, tiers, subs, buys, prefsEvents] = await Promise.all([
    q('paid_posts::PaywallCreated'),
    q('subscriptions::TierCreated'),
    q('subscriptions::Subscribed'),
    q('paid_posts::PostPurchased'),
    q('creator_prefs::PrefsChanged'),
  ])
  // 프로필 잠금 설정의 진실의 원본 = 체인 (크리에이터 서명 이벤트, 최신이 승리)
  const prefsByCreator = new Map()
  for (const e of prefsEvents.data) {
    const p = e.parsedJson
    if (!prefsByCreator.has(p.creator)) {
      prefsByCreator.set(p.creator, {
        locked: !!p.profile_locked,
        previews: !!p.show_locked_previews,
      })
    }
  }
  const prefsOf = addr => prefsByCreator.get(addr) || { locked: false, previews: true }
  const paywallByPost = new Map(pay.data.map(e => [e.parsedJson.post_id, e.parsedJson]))
  const tierInfo = new Map(tiers.data.map(e => [e.parsedJson.tier, e.parsedJson]))
  // (tier, subscriber) → 최신 만료시각 (연장 구독은 이벤트가 여러 번 — 최댓값이 진실)
  const subExpiry = new Map()
  for (const e of subs.data) {
    const p = e.parsedJson
    const k = `${p.tier}:${p.subscriber}`
    if (Number(p.expires_ms) > (subExpiry.get(k) || 0)) subExpiry.set(k, Number(p.expires_ms))
  }
  const purchased = new Set(buys.data.map(e => `${e.parsedJson.post_id}:${e.parsedJson.buyer}`))
  const isSubscribedTo = (viewerAddr, creatorAddr) => {
    const now = Date.now()
    for (const [tier, t] of tierInfo) {
      if (t.creator === creatorAddr && (subExpiry.get(`${tier}:${viewerAddr}`) || 0) > now) return true
    }
    return false
  }
  const tierByCreator = new Map()
  for (const [id, t] of tierInfo) {
    if (!tierByCreator.has(t.creator)) {
      tierByCreator.set(t.creator, {
        id,
        priceGeunhwa: Number(t.price),
        periodMs: Number(t.period_ms),
      })
    }
  }
  return { paywallByPost, isSubscribedTo, purchased, tierInfo, subExpiry, tierByCreator, prefsOf }
}

// 비열람 자격 뷰어에게는 본문 대신 잠금 정보를 내려줌.
// post.humming 마커(구조화)로 humming-app이 네이티브 잠금 카드를 그리고,
// record.text 대체문은 무수정 Bluesky 클라이언트용 폴백.
function gatePosts(posts, viewerAcct, gate) {
  return posts.map(item => {
    const viewer = viewerAcct?.address
    const isAuthor = viewer === item.author.address
    const subscribed = !!viewer && gate.isSubscribedTo(viewer, item.author.address)
    const pw = gate.paywallByPost.get(item.postId)
    const paywallLocked =
      pw && !isAuthor && !subscribed && !(viewer && gate.purchased.has(`${item.postId}:${viewer}`))
    const prefs = gate.prefsOf(item.author.address)
    const profileLocked = prefs.locked && !isAuthor && !subscribed
    if (!paywallLocked && !profileLocked) return item
    const tier = gate.tierByCreator.get(item.author.address) || null
    const priceH = pw ? Number(pw.price) / 1e9 : null
    // 미디어 서명 URL(embed)은 응답에서 통째로 제거 — 잠금의 실체는 "서버가 안 주는 것".
    // 개수/종류만 티저로 남긴다 (전환 유도, OnlyFans와 동일한 메커니즘)
    const { embed: _stripped, ...gatedPost } = item.post
    return {
      ...item,
      post: {
        ...gatedPost,
        humming: {
          locked: true,
          reason: paywallLocked ? 'paywall' : 'profile',
          // 전면 잠금 크리에이터의 프로필 피드 노출 방식 (온체인 설정)
          previews: prefs.previews,
          priceGeunhwa: pw ? Number(pw.price) : null,
          tier: tier ? { priceGeunhwa: tier.priceGeunhwa, periodMs: tier.periodMs } : null,
          media: mediaCounts(item.media),
        },
        record: {
          ...item.post.record,
          text: paywallLocked
            ? `🔒 구독자 전용 게시물입니다\n\n@${item.author.handle} 구독 또는 단건 구매(${priceH} HANEUL)로 열람할 수 있어요. 열람 자격은 Haneul 온체인 구독 상태로 판정됩니다.`
            : `🔒 @${item.author.handle}의 게시물은 구독자에게만 공개됩니다.`,
        },
      },
    }
  })
}

// 뷰어 문맥까지 얹은 게시물 로드 — 모든 읽기 핸들러의 진입점
async function loadPostsFor(req) {
  const [posts, gate] = await Promise.all([loadPosts(), loadGateState()])
  return gatePosts(posts, byDid(didFromAuth(req)), gate)
}

// ---- server ----
const app = express()
app.use(cors({ origin: true, allowedHeaders: '*', exposedHeaders: '*' }))
app.use(express.json({ limit: '5mb' }))

const implemented = {}
function xrpc(method, nsid, handler) {
  implemented[nsid] = true
  app[method](`/xrpc/${nsid}`, async (req, res) => {
    try {
      const out = await handler(req, res)
      if (!res.headersSent) res.json(out ?? {})
    } catch (e) {
      console.error(`[${nsid}] ERROR:`, e.message)
      res
        .status(e.status || 500)
        .json({ error: e.errorName || 'InternalServerError', message: e.message })
    }
  })
}

// --- com.atproto.server ---
xrpc('get', 'com.atproto.server.describeServer', () => ({
  did: 'did:web:localhost',
  availableUserDomains: ['.hum.haneul'],
}))

// 가입 = 닉네임 = 지갑: 앱의 표준 가입 화면이 이 엔드포인트 하나로 온체인 신원을 만든다.
// ① 지갑 생성(키스토어, 수탁 데모) ② 가스 지급 ③ hum.haneul leaf 서브네임 발급(앱이 대납)
xrpc('post', 'com.atproto.server.createAccount', async req => {
  const { handle, password } = req.body || {}
  const fail = (status, errorName, message) => {
    const e = new Error(message)
    e.status = status
    e.errorName = errorName
    throw e
  }
  if (!handle || !password) fail(400, 'InvalidRequest', 'handle and password are required')
  const h = String(handle).toLowerCase()
  if (!h.endsWith('.hum.haneul')) fail(400, 'UnsupportedDomain', 'handle must end with .hum.haneul')
  const name = h.slice(0, -'.hum.haneul'.length)
  // 온체인 제약과 동일: SubDomainConfig min_label_size=3, 라벨 문자셋
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(name))
    fail(400, 'InvalidHandle', '닉네임은 3~30자의 영소문자/숫자/하이픈이어야 합니다')
  if (byHandle(h)) fail(400, 'HandleNotAvailable', '이미 사용 중인 닉네임입니다')
  if (await chainNameRecord(h)) fail(400, 'HandleNotAvailable', '이미 온체인에 등록된 닉네임입니다')

  const acct = await serialized(async () => {
    // ① 새 지갑 — 파사드 키스토어에 등록 (비수탁 전환 전까지의 수탁 데모)
    let address
    try {
      const { stdout } = await exec(CLI, ['client', 'new-address', 'ed25519', `hum-${name}`])
      address = (stdout.match(/0x[0-9a-f]{64}/) || [])[0]
    } catch {
      // 키스토어는 로컬넷 regenesis와 무관하게 영속 — 이전 세션의 alias가 남아 있으면
      // 그 키를 재사용 (온체인 이름 중복검사는 위에서 이미 통과)
      const { stdout } = await exec(CLI, ['keytool', 'list', '--json'])
      address = JSON.parse(stdout).find(k => k.alias === `hum-${name}`)?.haneulAddress
    }
    if (!address) throw new Error('wallet creation failed')
    // ② 가스 지급 (로컬넷 faucet; 메인넷에선 스폰서드 tx로 대체)
    await exec(CLI, ['client', 'faucet', '--address', address])
    // ③ 닉네임 발급 — hum.haneul 부모 NFT 소유자(앱 지갑)가 서명·가스 부담
    await exec(CLI, ['client', 'switch', '--address', APP_WALLET])
    await exec(CLI, [
      'client', 'ptb',
      '--move-call', `${NS_SUB_PKG}::subdomains::new_leaf`,
      `@${NS_OBJ}`, `@${HUM_PARENT_NFT}`, '@0x6', `"${h}"`, `@${address}`,
      '--gas-budget', '50000000',
    ])
    return {
      handle: h,
      did: `did:web:${h}`,
      address,
      displayName: name,
      description: 'Humming 신규 유저',
      password,
      signup: true,
    }
  })
  ACCOUNTS.push(acct)
  persistAccounts()
  console.log(`🐣 가입: ${acct.handle} → 지갑 ${acct.address.slice(0, 10)}… (온체인 leaf 등록)`)
  return {
    accessJwt: makeJwt(acct.did, 'com.atproto.access'),
    refreshJwt: makeJwt(acct.did, 'com.atproto.refresh'),
    handle: acct.handle,
    did: acct.did,
  }
})

xrpc('post', 'com.atproto.server.createSession', req => {
  const { identifier, password } = req.body
  const acct = byHandle(identifier)
  if (!acct || password !== acct.password) {
    const e = new Error('Invalid identifier or password')
    e.status = 401
    throw e
  }
  console.log(`✅ 로그인: ${acct.handle}`)
  return {
    accessJwt: makeJwt(acct.did, 'com.atproto.access'),
    refreshJwt: makeJwt(acct.did, 'com.atproto.refresh'),
    handle: acct.handle,
    did: acct.did,
    email: `${acct.handle.split('.')[0]}@humming.local`,
    emailConfirmed: true,
    active: true,
  }
})

xrpc('post', 'com.atproto.server.refreshSession', req => {
  const acct = byDid(didFromAuth(req)) || ACCOUNTS[0]
  return {
    accessJwt: makeJwt(acct.did, 'com.atproto.access'),
    refreshJwt: makeJwt(acct.did, 'com.atproto.refresh'),
    handle: acct.handle,
    did: acct.did,
    active: true,
  }
})

xrpc('get', 'com.atproto.server.getSession', req => {
  const acct = byDid(didFromAuth(req)) || ACCOUNTS[0]
  return {
    did: acct.did,
    handle: acct.handle,
    email: `${acct.handle.split('.')[0]}@humming.local`,
    emailConfirmed: true,
    active: true,
  }
})

xrpc('get', 'com.atproto.identity.resolveHandle', async req => {
  const acct = byHandle(req.query.handle)
  if (acct) return { did: acct.did }
  // 파사드가 모르는 이름도 온체인 레지스트리가 알면 신원으로 인정 (체인이 원본)
  const rec = await chainNameRecord(req.query.handle)
  if (rec) return { did: `did:web:${String(req.query.handle).toLowerCase()}` }
  const e = new Error('Unable to resolve handle')
  e.status = 400
  throw e
})

// --- app.bsky.actor ---
async function detailedProfile(actorParam) {
  const acct = byHandle(actorParam) || byDid(actorParam)
  if (!acct) {
    const e = new Error('Profile not found')
    e.status = 400
    throw e
  }
  const posts = await loadPosts()
  return {
    ...profileBasic(acct),
    description: acct.description,
    followersCount: acct.handle.startsWith('bob') ? 1 : 0,
    followsCount: acct.handle.startsWith('alice') ? 1 : 0,
    postsCount: posts.filter(p => p.author.did === acct.did).length,
    indexedAt: new Date().toISOString(),
    associated: { lists: 0, feedgens: 0, starterPacks: 0, labeler: false },
  }
}
xrpc('get', 'app.bsky.actor.getProfile', req => detailedProfile(req.query.actor))
xrpc('get', 'app.bsky.actor.getProfiles', async req => {
  const actors = [].concat(req.query.actors || [])
  return { profiles: await Promise.all(actors.map(detailedProfile)) }
})
xrpc('get', 'app.bsky.actor.getPreferences', () => ({
  preferences: [
    {
      $type: 'app.bsky.actor.defs#savedFeedsPrefV2',
      items: [{ id: '3jui7kd54zh2y', type: 'timeline', value: 'following', pinned: true }],
    },
    {
      $type: 'app.bsky.actor.defs#personalDetailsPref',
      birthDate: '2000-01-01T00:00:00.000Z',
    },
  ],
}))
xrpc('post', 'app.bsky.actor.putPreferences', () => ({}))

// --- app.bsky.feed ---
xrpc('get', 'app.bsky.feed.getTimeline', async req => {
  const posts = await loadPostsFor(req)
  console.log(`📜 getTimeline → 온체인 게시물 ${posts.length}개 서빙`)
  return { feed: posts.map(p => ({ post: p.post })) }
})
xrpc('get', 'app.bsky.feed.getAuthorFeed', async req => {
  const acct = byHandle(req.query.actor) || byDid(req.query.actor)
  const posts = await loadPostsFor(req)
  return {
    feed: posts
      .filter(p => acct && p.author.did === acct.did)
      // 온체인 설정 previews=false인 크리에이터는 비구독자 프로필 피드에서 글을 통째로 숨김
      // (담벼락 패널은 앱이 렌더) — previews=true면 잠금 카드로 노출
      .filter(p => !(p.post.humming?.reason === 'profile' && !p.post.humming?.previews))
      .map(p => ({ post: p.post })),
  }
})
xrpc('get', 'app.bsky.feed.getPostThread', async req => {
  const posts = await loadPostsFor(req)
  const found = findPostByUri(posts, req.query.uri)
  if (!found) {
    const e = new Error('Post not found')
    e.status = 400
    throw e
  }
  return {
    thread: {
      $type: 'app.bsky.feed.defs#threadViewPost',
      post: found.post,
      replies: posts
        .filter(p => p.repliedTo != null && String(p.repliedTo) === found.postId)
        .map(p => ({ $type: 'app.bsky.feed.defs#threadViewPost', post: p.post, replies: [] })),
    },
  }
})
// 답글 작성창 등이 개별 게시물을 uri 목록으로 재조회할 때 씀
xrpc('get', 'app.bsky.feed.getPosts', async req => {
  const uris = [].concat(req.query.uris || [])
  const posts = await loadPostsFor(req)
  return {
    posts: uris.map(u => findPostByUri(posts, u)?.post).filter(Boolean),
  }
})
xrpc('get', 'app.bsky.feed.getFeedGenerators', () => ({ feeds: [] }))
xrpc('get', 'app.bsky.feed.getActorLikes', () => ({ feed: [] }))
xrpc('get', 'app.bsky.feed.getLikes', () => ({ likes: [] }))
xrpc('get', 'app.bsky.feed.getRepostedBy', () => ({ repostedBy: [] }))
xrpc('get', 'app.bsky.feed.getQuotes', () => ({ posts: [] }))

// --- notifications / graph / labelers: quiet empties ---
xrpc('get', 'app.bsky.notification.listNotifications', () => ({
  notifications: [],
  seenAt: new Date().toISOString(),
}))
xrpc('get', 'app.bsky.notification.getUnreadCount', () => ({ count: 0 }))
xrpc('post', 'app.bsky.notification.updateSeen', () => ({}))
xrpc('get', 'app.bsky.notification.getPreferences', () => ({ preferences: {} }))
for (const g of ['getLists', 'getListMutes', 'getListBlocks']) {
  xrpc('get', `app.bsky.graph.${g}`, () => ({ lists: [] }))
}
xrpc('get', 'app.bsky.graph.getMutes', () => ({ mutes: [] }))
xrpc('get', 'app.bsky.graph.getBlocks', () => ({ blocks: [] }))
xrpc('get', 'app.bsky.graph.getFollows', async req => ({
  subject: await detailedProfile(req.query.actor),
  follows: [],
}))
xrpc('get', 'app.bsky.graph.getFollowers', async req => ({
  subject: await detailedProfile(req.query.actor),
  followers: [],
}))
xrpc('get', 'app.bsky.labeler.getServices', () => ({ views: [] }))
xrpc('get', 'com.atproto.repo.getRecord', async req => {
  const { repo, collection, rkey } = req.query
  const acct = byDid(repo) || byHandle(repo)
  if (acct && collection === 'app.bsky.actor.profile') {
    return {
      uri: `at://${acct.did}/app.bsky.actor.profile/${rkey || 'self'}`,
      cid: await fakeCid(acct.did + collection),
      value: {
        $type: 'app.bsky.actor.profile',
        displayName: acct.displayName,
        description: acct.description,
        createdAt: '2026-07-10T00:00:00.000Z',
      },
    }
  }
  const e = new Error('Record not found')
  e.status = 400
  throw e
})
xrpc('get', 'chat.bsky.convo.getLog', () => ({ logs: [] }))
xrpc('get', 'chat.bsky.convo.listConvos', () => ({ convos: [] }))
xrpc('get', 'app.bsky.unspecced.getConfig', () => ({ checkEmailConfirmed: false }))
// 연령확인(신형): 지역 규칙 없음 + 완전 접근 상태 — 데모 계정은 전부 성인
xrpc('get', 'app.bsky.ageassurance.getConfig', () => ({ regions: [] }))
xrpc('get', 'app.bsky.ageassurance.getState', () => ({
  state: { status: 'assured', access: 'full' },
  metadata: { accountCreatedAt: '2026-07-10T00:00:00.000Z' },
}))
xrpc('get', 'app.bsky.unspecced.getTaggedSuggestions', () => ({ suggestions: [] }))
xrpc('get', 'app.bsky.unspecced.getTrendingTopics', () => ({ topics: [], suggested: [] }))
xrpc('get', 'app.bsky.unspecced.getPopularFeedGenerators', () => ({ feeds: [] }))
xrpc('get', 'app.bsky.graph.getSuggestedFollowsByActor', () => ({ suggestions: [] }))
xrpc('get', 'app.bsky.actor.getSuggestions', () => ({ actors: [] }))
xrpc('get', 'app.bsky.actor.searchActors', () => ({ actors: [] }))
xrpc('get', 'app.bsky.actor.searchActorsTypeahead', () => ({ actors: [] }))
xrpc('get', 'app.bsky.feed.searchPosts', () => ({ posts: [] }))
xrpc('get', 'chat.bsky.convo.getUnreadCounts', () => ({ convos: {} }))
// at-uri는 authority 자리에 did 또는 handle 둘 다 올 수 있음 — 정규화해서 매칭
function findPostByUri(posts, uri) {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/.exec(uri || '')
  if (!m) return null
  const acct = byDid(m[1]) || byHandle(m[1])
  if (!acct) return null
  return posts.find(p => p.author.did === acct.did && p.postId === m[2])
}

// 스레드(게시물 상세) — 최신 앱은 V1 getPostThread 대신 이걸 씀
xrpc('get', 'app.bsky.unspecced.getPostThreadV2', async req => {
  const posts = await loadPostsFor(req)
  const anchor = findPostByUri(posts, req.query.anchor)
  if (!anchor) {
    const e = new Error('Post not found')
    e.status = 400
    throw e
  }
  const item = (p, depth) => ({
    uri: p.post.uri,
    depth,
    value: {
      $type: 'app.bsky.unspecced.defs#threadItemPost',
      post: p.post,
      moreParents: false,
      moreReplies: 0,
      opThread: false,
      hiddenByThreadgate: false,
      mutedByViewer: false,
    },
  })
  const thread = []
  // ancestors (negative depth), walking replied_to chain upward
  let cur = anchor
  let depth = 0
  while (cur.repliedTo != null) {
    const parent = posts.find(x => x.postId === String(cur.repliedTo))
    if (!parent) break
    depth--
    thread.unshift(item(parent, depth))
    cur = parent
  }
  thread.push(item(anchor, 0))
  for (const r of posts.filter(p => p.repliedTo != null && String(p.repliedTo) === anchor.postId)) {
    thread.push(item(r, 1))
  }
  return { thread, hasOtherReplies: false }
})
xrpc('get', 'app.bsky.unspecced.getPostThreadOtherV2', () => ({ thread: [] }))
// 탐색/프로필 부가 화면 스텁
xrpc('get', 'app.bsky.feed.getActorFeeds', () => ({ feeds: [] }))
xrpc('get', 'app.bsky.unspecced.getTrends', () => ({ trends: [] }))
xrpc('get', 'app.bsky.unspecced.getSuggestedUsersForExplore', () => ({ actors: [] }))
xrpc('get', 'app.bsky.unspecced.getSuggestedStarterPacks', () => ({ starterPacks: [] }))
xrpc('get', 'app.bsky.unspecced.getSuggestedFeeds', () => ({ feeds: [] }))
// "내 피드"에서 following 외 피드 요청 시에도 온체인 타임라인 반환
xrpc('get', 'app.bsky.feed.getFeed', async req => {
  const posts = await loadPostsFor(req)
  return { feed: posts.map(p => ({ post: p.post })) }
})

// --- writes: app → facade → PTB → chain ---
// CLI의 active address가 전역 상태라 쓰기는 큐로 직렬화
let writeQueue = Promise.resolve()
function serialized(fn) {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.catch(() => {})
  return run
}

// PTB 문자열 리터럴은 큰따옴표/역슬래시를 못 품음 — 데모 편법으로 유사 문자 치환
const sanitizeText = t => (t || '').replace(/"/g, '”').replace(/\\/g, '＼')

// ATProto TID(13자 base32-sortable) — commit.rev가 이 형식이 아니면 앱이 응답을 거부함
const TID_CHARS = '234567abcdefghijklmnopqrstuvwxyz'
function tidNow() {
  let n = (BigInt(Date.now()) * 1000n << 10n) | BigInt(Math.floor(Math.random() * 1024))
  let s = ''
  for (let i = 0; i < 13; i++) {
    s = TID_CHARS[Number(n & 31n)] + s
    n >>= 5n
  }
  return s
}

async function submitPostOnChain(acct, text, parentId, media, paywallGeunhwa) {
  // 페이월 가격은 서버가 재검증 (클라이언트 값 신뢰 금지): 0.01~100 HANEUL
  const paywall =
    Number.isFinite(Number(paywallGeunhwa)) &&
    Number(paywallGeunhwa) >= 10_000_000 &&
    Number(paywallGeunhwa) <= 100_000_000_000
      ? Math.floor(Number(paywallGeunhwa))
      : null
  return serialized(async () => {
    await exec(CLI, ['client', 'switch', '--address', acct.address])
    const args = [
      'client', 'ptb',
      '--move-call', `${PKG}::feed::request_create_post`,
      `@${FEED}`, `"${encodeContent(text, media)}"`,
      parentId != null ? `some(${parentId})` : 'none', 'none', 'none',
      '--assign', 'r',
      '--move-call', `${PKG}::feed::execute_create_post`,
      `@${FEED}`, `@${RULES}`, 'r.0', 'r.1', '@0x6',
    ]
    // 글 작성과 페이월 생성을 한 tx로 원자 확정 — 가격 없는 유료 글이 생길 틈이 없음
    if (paywall) {
      args.push(
        '--assign', 'pid',
        '--move-call', `${PKG}::paid_posts::create<${HANEUL_TYPE}>`,
        `@${FEED}`, 'pid', `${paywall}`,
      )
    }
    args.push('--gas-budget', '50000000')
    const { stdout } = await exec(CLI, args, { maxBuffer: 16 * 1024 * 1024 })
    const digest = /Transaction Digest: (\S+)/.exec(stdout)?.[1]
    const postId = /post_id\s*│\s*(\d+)/.exec(stdout)?.[1]
    if (!postId) throw new Error(`PostCreated 이벤트 미발견 (tx: ${digest ?? '없음'})`)
    if (paywall && !/PaywallCreated/.test(stdout))
      throw new Error(`페이월 생성 실패 (tx: ${digest})`)
    console.log(
      `⛓️  쓰기: post_id=${postId} by ${acct.handle}${paywall ? ` [유료 ${paywall / 1e9} HANEUL]` : ''} tx=${digest}`,
    )
    return { postId, digest }
  })
}

const parentIdFromUri = uri => /\/app\.bsky\.feed\.post\/(\d+)$/.exec(uri || '')?.[1] ?? null

function requireAuthAcct(req) {
  const acct = byDid(didFromAuth(req))
  if (!acct) {
    const e = new Error('Not authenticated')
    e.status = 401
    throw e
  }
  return acct
}

// 미디어 업로드: 파일은 디스크에(오프체인), 반환된 CID가 게시물의 온체인 포인터가 됨
app.post(
  '/xrpc/com.atproto.repo.uploadBlob',
  express.raw({ type: () => true, limit: '64mb' }),
  async (req, res) => {
    try {
      const acct = byDid(didFromAuth(req))
      if (!acct) return res.status(401).json({ error: 'AuthRequired' })
      const bytes = req.body
      const mime = req.headers['content-type'] || 'application/octet-stream'
      // 실제 PDS와 동일하게 blob CID = raw(0x55) + sha256 — 파일 내용이 곧 주소
      const digest = await sha256.digest(bytes)
      const cid = CID.createV1(0x55, digest).toString()
      fs.writeFileSync(path.join(MEDIA_DIR, cid), bytes)
      fs.writeFileSync(path.join(MEDIA_DIR, `${cid}.meta.json`), JSON.stringify({ mime, size: bytes.length }))
      console.log(`📦 업로드: ${cid.slice(0, 16)}… (${mime}, ${bytes.length}B) by ${acct.handle}`)
      res.json({ blob: { $type: 'blob', ref: { $link: cid }, mimeType: mime, size: bytes.length } })
    } catch (e) {
      console.error('[uploadBlob] ERROR:', e.message)
      res.status(500).json({ error: 'InternalServerError', message: e.message })
    }
  },
)
implemented['com.atproto.repo.uploadBlob'] = true

// 서명 URL 검증 후에만 원본 서빙 — URL 없이 CID만 알아도 접근 불가
app.get('/media/:cid', (req, res) => {
  const { cid } = req.params
  const { exp, sig } = req.query
  if (!/^[a-z2-7]+$/.test(cid)) return res.status(400).end()
  if (!exp || Number(exp) < Date.now() || sig !== signMedia(cid, exp)) {
    return res.status(403).json({ error: 'Forbidden', message: '서명이 없거나 만료된 미디어 URL' })
  }
  const file = path.join(MEDIA_DIR, cid)
  if (!fs.existsSync(file)) return res.status(404).end()
  try {
    const meta = JSON.parse(fs.readFileSync(`${file}.meta.json`, 'utf8'))
    res.setHeader('Content-Type', meta.mime)
  } catch {}
  res.setHeader('Cache-Control', 'private, max-age=900')
  fs.createReadStream(file).pipe(res)
})

// 컴포저가 첨부한 이미지 embed에서 온체인 포인터 재료를 추출
function mediaFromEmbed(embed) {
  if (embed?.$type !== 'app.bsky.embed.images') return []
  return (embed.images || [])
    .map(img => ({
      cid: img.image?.ref?.$link || '',
      mime: img.image?.mimeType || 'image/jpeg',
      w: img.aspectRatio?.width || 0,
      h: img.aspectRatio?.height || 0,
    }))
    .filter(m => m.cid)
}

xrpc('post', 'com.atproto.repo.applyWrites', async req => {
  const acct = requireAuthAcct(req)
  const results = []
  for (const w of req.body.writes || []) {
    const isCreate = (w.$type || '').endsWith('#create')
    if (isCreate && w.collection === 'app.bsky.feed.post') {
      const parentId = parentIdFromUri(w.value?.reply?.parent?.uri)
      const media = mediaFromEmbed(w.value?.embed)
      const { postId, digest } = await submitPostOnChain(acct, w.value?.text, parentId, media, w.value?.humming?.paywallGeunhwa)
      results.push({
        $type: 'com.atproto.repo.applyWrites#createResult',
        uri: `at://${acct.did}/app.bsky.feed.post/${postId}`,
        cid: await fakeCid(digest),
        validationStatus: 'valid',
      })
    } else {
      // threadgate/postgate 등 부수 레코드: 체인 매핑 전까지 수용만
      console.log(`   (applyWrites: ${w.collection} 미매핑 — 수용만)`)
      results.push({
        $type: 'com.atproto.repo.applyWrites#createResult',
        uri: `at://${acct.did}/${w.collection}/${w.rkey || 'self'}`,
        cid: await fakeCid(acct.did + w.collection + (w.rkey || '')),
        validationStatus: 'valid',
      })
    }
  }
  return {
    commit: { cid: await fakeCid(`commit${Date.now()}`), rev: tidNow() },
    results,
  }
})

xrpc('post', 'com.atproto.repo.createRecord', async req => {
  const acct = requireAuthAcct(req)
  const { collection, record } = req.body
  if (collection === 'app.bsky.feed.post') {
    const parentId = parentIdFromUri(record?.reply?.parent?.uri)
    const media = mediaFromEmbed(record?.embed)
    const { postId, digest } = await submitPostOnChain(acct, record?.text, parentId, media, record?.humming?.paywallGeunhwa)
    return {
      uri: `at://${acct.did}/app.bsky.feed.post/${postId}`,
      cid: await fakeCid(digest),
      commit: { cid: await fakeCid(digest + 'commit'), rev: tidNow() },
      validationStatus: 'valid',
    }
  }
  // like/repost/follow 등: 온체인 graph 매핑 전까지 수용만 (새로고침 시 사라짐)
  const rkey = Date.now().toString(36)
  console.log(`   (createRecord: ${collection} 미매핑 — 수용만)`)
  return {
    uri: `at://${acct.did}/${collection}/${rkey}`,
    cid: await fakeCid(collection + rkey),
    validationStatus: 'valid',
  }
})

// 미매핑 레코드 삭제(좋아요 취소 등)도 소프트 수용
xrpc('post', 'com.atproto.repo.deleteRecord', () => ({}))

// --- app.humming.monetization: 구독/팁 — humming-app 네이티브 버튼이 호출 ---
// 크리에이터의 티어 + 뷰어의 구독 상태 (버튼 렌더링용)
xrpc('get', 'app.humming.monetization.getCreator', async req => {
  const creator = byHandle(req.query.actor) || byDid(req.query.actor)
  if (!creator) {
    const e = new Error('Unknown actor')
    e.status = 400
    throw e
  }
  const gate = await loadGateState()
  let tier = null
  for (const [id, t] of gate.tierInfo) {
    if (t.creator === creator.address) {
      tier = { id, price: Number(t.price), periodMs: Number(t.period_ms) }
      break
    }
  }
  const viewer = byDid(didFromAuth(req))
  let subscribed = false
  let expiresMs = null
  if (tier && viewer) {
    const exp = gate.subExpiry.get(`${tier.id}:${viewer.address}`) || 0
    subscribed = exp > Date.now()
    if (exp) expiresMs = exp
  }
  const posts = await loadPosts()
  const mine = posts.filter(p => p.author.did === creator.did)
  const media = mine.reduce(
    (acc, p) => {
      const c = mediaCounts(p.media)
      return { images: acc.images + c.images, videos: acc.videos + c.videos }
    },
    { images: 0, videos: 0 },
  )
  return {
    tier,
    viewer: { subscribed, expiresMs },
    profileLocked: gate.prefsOf(creator.address).locked,
    stats: { posts: mine.length, ...media },
  }
})

// 구독 결제: 뷰어 지갑이 서명 → subscriptions::subscribe (95/5 온체인 분배)
xrpc('post', 'app.humming.monetization.subscribe', async req => {
  const viewer = requireAuthAcct(req)
  const creator = byHandle(req.body.creator) || byDid(req.body.creator)
  if (!creator) {
    const e = new Error('Unknown creator')
    e.status = 400
    throw e
  }
  const gate = await loadGateState()
  let tierId = null
  let price = null
  for (const [id, t] of gate.tierInfo) {
    if (t.creator === creator.address) {
      tierId = id
      price = Number(t.price)
      break
    }
  }
  if (!tierId) {
    const e = new Error('Creator has no subscription tier')
    e.status = 400
    throw e
  }
  const digest = await serialized(async () => {
    await exec(CLI, ['client', 'switch', '--address', viewer.address])
    const { stdout } = await exec(
      CLI,
      [
        'client', 'ptb',
        '--split-coins', 'gas', `[${price}]`,
        '--assign', 'pay',
        '--move-call', `${PKG}::subscriptions::subscribe<${HANEUL_TYPE}>`,
        `@${tierId}`, `@${FEE_CONFIG}`, `@${viewer.address}`, `${price}`, 'pay.0', '@0x6',
        '--transfer-objects', '[pay.0]', `@${viewer.address}`,
        '--gas-budget', '50000000',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    const d = /Transaction Digest: (\S+)/.exec(stdout)?.[1]
    if (!d || !/Subscribed/.test(stdout)) throw new Error(`구독 tx 실패 (digest: ${d ?? '없음'})`)
    return d
  })
  console.log(`💳 구독: ${viewer.handle} → ${creator.handle} (${price / 1e9} HANEUL) tx=${digest}`)
  return { digest, priceGeunhwa: price }
})

// 단건 구매(PPV): 뷰어 지갑이 서명 → paid_posts::purchase — 구독 없이 이 글만 영구 열람
xrpc('post', 'app.humming.monetization.purchasePost', async req => {
  const viewer = requireAuthAcct(req)
  const postId = String(req.body.postId ?? '').match(/\d+$/)?.[0]
  if (!postId) {
    const e = new Error('postId required')
    e.status = 400
    throw e
  }
  const gate = await loadGateState()
  const pw = gate.paywallByPost.get(postId)
  if (!pw) {
    const e = new Error('No paywall on this post')
    e.status = 400
    throw e
  }
  const price = Number(pw.price)
  const digest = await serialized(async () => {
    await exec(CLI, ['client', 'switch', '--address', viewer.address])
    const { stdout } = await exec(
      CLI,
      [
        'client', 'ptb',
        '--split-coins', 'gas', `[${price}]`,
        '--assign', 'pay',
        '--move-call', `${PKG}::paid_posts::purchase<${HANEUL_TYPE}>`,
        `@${pw.paywall}`, `@${FEE_CONFIG}`, `@${FEED}`, `${price}`, 'pay.0',
        '--transfer-objects', '[pay.0]', `@${viewer.address}`,
        '--gas-budget', '50000000',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    const d = /Transaction Digest: (\S+)/.exec(stdout)?.[1]
    if (!d || !/PostPurchased/.test(stdout)) throw new Error(`단건 구매 tx 실패 (digest: ${d ?? '없음'})`)
    return d
  })
  console.log(`🎟️ 단건 구매: ${viewer.handle} → post ${postId} (${price / 1e9} HANEUL) tx=${digest}`)
  return { digest, priceGeunhwa: price, postId }
})

// 팁: 뷰어 지갑이 서명 → tips::tip_post/tip — TipSent 이벤트로 인덱싱 가능
// (글 팁이면 수취인은 체인이 글 작성자로 강제, 클라이언트가 주소를 못 바꿈)
xrpc('post', 'app.humming.monetization.tip', async req => {
  const viewer = requireAuthAcct(req)
  const creator = byHandle(req.body.creator) || byDid(req.body.creator)
  const amount = Math.floor(Number(req.body.amountGeunhwa))
  const postId = String(req.body.postId ?? '').match(/^\d+$/)?.[0] ?? null
  if (!creator || creator.did === viewer.did) {
    const e = new Error('Invalid tip target')
    e.status = 400
    throw e
  }
  // 데모 가드레일: 0 < 팁 ≤ 10 HANEUL
  if (!(amount > 0 && amount <= 10_000_000_000)) {
    const e = new Error('Invalid tip amount')
    e.status = 400
    throw e
  }
  const call = postId
    ? [`${PKG}::tips::tip_post<${HANEUL_TYPE}>`, `@${FEE_CONFIG}`, `@${FEED}`, `${postId}`, `${amount}`, 'pay.0']
    : [`${PKG}::tips::tip<${HANEUL_TYPE}>`, `@${FEE_CONFIG}`, `@${creator.address}`, `${amount}`, 'pay.0']
  const digest = await serialized(async () => {
    await exec(CLI, ['client', 'switch', '--address', viewer.address])
    const { stdout } = await exec(
      CLI,
      [
        'client', 'ptb',
        '--split-coins', 'gas', `[${amount}]`,
        '--assign', 'pay',
        '--move-call', ...call,
        '--transfer-objects', '[pay.0]', `@${viewer.address}`,
        '--gas-budget', '50000000',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    const d = /Transaction Digest: (\S+)/.exec(stdout)?.[1]
    if (!d || !/TipSent/.test(stdout)) throw new Error(`팁 tx 실패 (digest: ${d ?? '없음'})`)
    return d
  })
  console.log(`💰 팁: ${viewer.handle} → ${creator.handle}${postId ? ` (post ${postId})` : ''} (${amount / 1e9} HANEUL) tx=${digest}`)
  return { digest, amountGeunhwa: amount }
})

// 크리에이터 되기: 티어 생성(+선택적 프로필 잠금)을 본인 지갑 서명으로 온체인 확정.
// KYC는 의도적 오프체인(신분증을 퍼블릭 체인에 못 올림) — 데모에서는 즉시 통과 스텁,
// 통과 사실만 verified 배지로 반영. 실서비스에서는 외부 KYC 벤더 콜백이 이 자리에 들어옴.
xrpc('post', 'app.humming.creator.becomeCreator', async req => {
  const viewer = requireAuthAcct(req)
  const price = Math.floor(Number(req.body.priceGeunhwa))
  const periodDays = Math.floor(Number(req.body.periodDays ?? 30))
  const lockMode = String(req.body.lockMode ?? 'open') // open | tease | lock
  const fail = (status, message) => {
    const e = new Error(message)
    e.status = status
    throw e
  }
  // 가드레일: 0.01 ~ 100 HANEUL / 1~365일
  if (!(price >= 10_000_000 && price <= 100_000_000_000)) fail(400, '구독료는 0.01~100 HANEUL 사이여야 합니다')
  if (!(periodDays >= 1 && periodDays <= 365)) fail(400, '구독 기간은 1~365일 사이여야 합니다')
  if (!['open', 'tease', 'lock'].includes(lockMode)) fail(400, 'lockMode는 open/tease/lock 중 하나입니다')
  const gate = await loadGateState()
  if (gate.tierByCreator.has(viewer.address)) fail(400, '이미 크리에이터입니다 (티어 존재)')

  const periodMs = periodDays * 24 * 60 * 60 * 1000
  const name = viewer.handle.split('.')[0]
  const digest = await serialized(async () => {
    await exec(CLI, ['client', 'switch', '--address', viewer.address])
    const args = [
      'client', 'ptb',
      '--move-call', `${PKG}::subscriptions::create<${HANEUL_TYPE}>`,
      `${price}`, `${periodMs}`, `"ipfs://humming-tier-${name}"`,
      '--assign', 'tier_cap',
      '--transfer-objects', '[tier_cap]', `@${viewer.address}`,
    ]
    // 잠금 모드는 티어와 같은 PTB로 원자 확정 (tease=티저 노출, lock=전면 잠금)
    if (lockMode !== 'open') {
      args.push(
        '--move-call', `${PKG}::creator_prefs::set_prefs`,
        `@${PREFS_REGISTRY}`, 'true', `${lockMode === 'tease'}`,
      )
    }
    args.push('--gas-budget', '50000000')
    const { stdout } = await exec(CLI, args, { maxBuffer: 16 * 1024 * 1024 })
    const d = /Transaction Digest: (\S+)/.exec(stdout)?.[1]
    if (!d || !/TierCreated/.test(stdout)) throw new Error(`티어 생성 tx 실패 (digest: ${d ?? '없음'})`)
    return d
  })
  // KYC 스텁 통과 → 인증 크리에이터 배지
  viewer.verified = true
  persistAccounts()
  console.log(`🎨 크리에이터 전환: ${viewer.handle} (${price / 1e9} HANEUL/${periodDays}일, ${lockMode}) tx=${digest}`)
  return { digest, tier: { priceGeunhwa: price, periodMs }, lockMode, verified: true }
})

// 내 수익: 온체인 이벤트 3종(Subscribed/TipSent/PostPurchased)을 크리에이터 기준으로 집계.
// 구독은 tier→creator, PPV·글 귀속 팁은 post→작성자로 귀속. net = amount − fee(5%).
xrpc('get', 'app.humming.creator.getEarnings', async req => {
  const viewer = requireAuthAcct(req)
  const q = type => rpc('haneulx_queryEvents', [{ MoveEventType: `${PKG}::${type}` }, null, 50, true])
  const [subs, tips, buys, posts, gate] = await Promise.all([
    q('subscriptions::Subscribed'),
    q('tips::TipSent'),
    q('paid_posts::PostPurchased'),
    loadPosts(),
    loadGateState(),
  ])
  const authorOf = postId => posts.find(p => p.postId === String(postId))?.author.address
  const nameOf = addr => byAddress(addr)?.handle ?? `${addr.slice(0, 8)}…`
  const items = []
  for (const e of subs.data) {
    const p = e.parsedJson
    const creator = gate.tierInfo.get(p.tier)?.creator
    if (creator !== viewer.address) continue
    items.push({
      kind: 'subscription',
      from: nameOf(p.subscriber),
      grossGeunhwa: Number(p.amount),
      netGeunhwa: Number(p.amount) - Number(p.fee),
      atMs: Number(e.timestampMs),
      tx: e.id.txDigest,
    })
  }
  for (const e of tips.data) {
    const p = e.parsedJson
    if (p.to !== viewer.address) continue
    items.push({
      kind: 'tip',
      from: nameOf(p.from),
      postId: p.post_id ?? null,
      grossGeunhwa: Number(p.amount),
      netGeunhwa: Number(p.amount) - Number(p.fee),
      atMs: Number(e.timestampMs),
      tx: e.id.txDigest,
    })
  }
  for (const e of buys.data) {
    const p = e.parsedJson
    if (authorOf(p.post_id) !== viewer.address) continue
    items.push({
      kind: 'purchase',
      from: nameOf(p.buyer),
      postId: p.post_id,
      grossGeunhwa: Number(p.amount),
      netGeunhwa: Number(p.amount) - Number(p.fee),
      atMs: Number(e.timestampMs),
      tx: e.id.txDigest,
    })
  }
  items.sort((a, b) => b.atMs - a.atMs)
  const sum = kind =>
    items.filter(i => i.kind === kind).reduce((a, i) => a + i.netGeunhwa, 0)
  const totals = {
    subscriptionGeunhwa: sum('subscription'),
    tipGeunhwa: sum('tip'),
    purchaseGeunhwa: sum('purchase'),
  }
  totals.totalGeunhwa = totals.subscriptionGeunhwa + totals.tipGeunhwa + totals.purchaseGeunhwa
  const tier = gate.tierByCreator.get(viewer.address) || null
  return { totals, items: items.slice(0, 30), tier, isCreator: !!tier }
})

// --- catch-all: log what the app asks for, fail soft ---
app.all('/xrpc/:nsid', (req, res) => {
  console.log(`🕳️  미구현 호출: ${req.method} ${req.params.nsid}`)
  res.status(501).json({ error: 'MethodNotImplemented', message: req.params.nsid })
})

app.listen(PORT, () => {
  console.log(`🚀 Humming XRPC 파사드: http://localhost:${PORT}`)
  console.log(`   체인: ${RPC} / 패키지: ${PKG.slice(0, 10)}…`)
  loadPosts()
    .then(p => console.log(`   온체인 게시물 ${p.length}개 로드 완료`))
    .catch(e => console.error('   ⚠️ 체인 조회 실패:', e.message))
})
