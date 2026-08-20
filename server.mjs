// Humming XRPC Facade — serves the Bluesky app from the Haneul chain.
// The app speaks ATProto XRPC; we answer from humming contract events on localnet.
// 쓰기 = SDK 인프로세스 서명(lib/chain), 읽기 = 저널·객체 재구성·체크포인트 테일링 인덱스(lib/indexer).
import express from 'express'
import cors from 'cors'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NETWORK, RPC_URL, IS_LOCALNET, MAINNET_CHAIN_ID, PKG, NS_PKG, NS_OBJ, APP_WALLET, HANEUL_TYPE,
  DENY_RESERVED_TABLE, DENY_BLOCKED_TABLE,
} from './lib/config.mjs'
import { verifyJwt, sessionTokens, hashPassword, verifyPassword, DUMMY_HASH } from './lib/auth.mjs'
import {
  checkNewPassword, isAllowedMediaMime, safeEqual,
  MAX_POST_TEXT_CHARS, MAX_DISPLAY_NAME_CHARS, MAX_DESCRIPTION_CHARS, MAX_APPLY_WRITES,
} from './lib/policy.mjs'
import { revokeSession, isRevoked, tokenId } from './lib/revocation.mjs'
import { writeFileAtomic } from './lib/atomic.mjs'
import { noteChange as noteBackupChange, startBackups, flushBackups } from './lib/backup.mjs'
import { idempotent, idempotencyKeyFor } from './lib/idempotency.mjs'
import {
  withPendingTx, reconcilePendingTxs, PENDING_HORIZON_MS,
  loadPendingSignups, addPendingSignup, removePendingSignup,
} from './lib/pending.mjs'
import { rateLimit } from './lib/ratelimit.mjs'
import { clampLimit, pagePosts } from './lib/paginate.mjs'
import { loadKeys, importFromCliKeystore, createWallet, removeWallet, keypairFor } from './lib/keys.mjs'
import { bcs } from '@haneullabs/haneul/bcs'
import { grpcClient } from './lib/client.mjs'
import { chainIdentifier, getObjectJson, listAllDynamicFields } from './lib/grpc.mjs'
import {
  execTx, faucet, buildStarterGas,
  buildNewLeaf, buildCreatePost, buildSubscribe, buildPurchase, buildTip, buildBecomeCreator,
} from './lib/chain.mjs'
import {
  state as chainState, stateVersion, gateView, initIndex, startTailing, stats,
  tailingHealth, stopTailing, flushCursor,
} from './lib/indexer.mjs'
import { newRequestId, auditMoney } from './lib/audit.mjs'

const PORT = Number(process.env.PORT ?? 3025)
// 미디어 서명 URL에 박히는 외부 노출 주소 — 배포 시 HUMMING_PUBLIC_URL 필수(부팅 가드가 강제)
const PUBLIC_URL = (process.env.HUMMING_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '')
// 가입 스타터 가스(GEUNHWA) — faucet 없는 체인에서 APP_WALLET이 새 지갑에 지급하는 초기 금액.
// 하루 지출 상한 = 이 값 × HUMMING_MAX_SIGNUPS_PER_DAY (기본 0.2 HANEUL × 200 = 40 HANEUL)
const STARTER_GEUNHWA = BigInt(process.env.HUMMING_STARTER_GEUNHWA ?? 200_000_000)

// ---- 미디어 저장소: 콘텐츠는 오프체인, 체인에는 CID 포인터만 ----
// 파일 삭제 = 콘텐츠 삭제 가능(법적 요건), 체인의 CID는 존재 증명만 남음
const MEDIA_DIR =
  process.env.HUMMING_MEDIA_DIR || fileURLToPath(new URL('./media', import.meta.url))
fs.mkdirSync(MEDIA_DIR, { recursive: true })
// 서명 비밀키는 프로세스 수명 — URL은 요청마다 새로 발급되므로 재시작 무해
const MEDIA_SECRET = crypto.randomBytes(32)
const MEDIA_URL_TTL_MS = 15 * 60 * 1000
const signMedia = (cid, exp) =>
  crypto.createHmac('sha256', MEDIA_SECRET).update(`${cid}:${exp}`).digest('base64url')
// 열람 자격이 확인된 응답에만 실리는 만료형 서명 URL
function mediaUrl(cid) {
  const exp = Date.now() + MEDIA_URL_TTL_MS
  return `${PUBLIC_URL}/media/${cid}?exp=${exp}&sig=${signMedia(cid, exp)}`
}

// content_uri 인코딩: 본문 뒤에 미디어 포인터·언어 태그를 덧붙임 (CID 전달 규약)
// 형식: <text>[ §media:...][ §langs:ko,en] — 마커는 항상 이 순서로 뒤에 온다
const MEDIA_MARK = ' §media:'
const LANGS_MARK = ' §langs:'
// BCP-47 형태만 통과 (컴포저 언어 선택값), 최대 3개 — ATProto post.langs 상한과 동일
function cleanLangs(langs) {
  if (!Array.isArray(langs)) return []
  return langs
    .filter(l => typeof l === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(l))
    .slice(0, 3)
}
function encodeContent(text, media, langs) {
  let t = text || ''
  if (media?.length)
    t +=
      MEDIA_MARK +
      media.map(m => `${m.cid}~${m.mime.replace('/', '_')}~${m.w}x${m.h}`).join(',')
  const ls = cleanLangs(langs)
  if (ls.length) t += LANGS_MARK + ls.join(',')
  return t
}
function decodeContent(raw) {
  let rest = raw || ''
  let langs = []
  const li = rest.lastIndexOf(LANGS_MARK)
  if (li >= 0) {
    langs = cleanLangs(rest.slice(li + LANGS_MARK.length).split(','))
    rest = rest.slice(0, li)
  }
  const i = rest.indexOf(MEDIA_MARK)
  if (i < 0) return { text: rest, media: [], langs }
  const media = rest
    .slice(i + MEDIA_MARK.length)
    .split(',')
    .map(s => {
      const [cid, mime, dims] = s.split('~')
      const [w, h] = (dims || '').split('x').map(Number)
      return { cid, mime: (mime || 'image_jpeg').replace('_', '/'), w: w || 0, h: h || 0 }
    })
    .filter(m => m.cid)
  return { text: rest.slice(0, i), media, langs }
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
// 시드 데모 계정(공개 비밀번호)은 로컬넷 posture에서만 로드된다 — 배포 시 소스 편집 없이
// 구조적으로 제외되고, 아래 배포 가드가 잔존 여부를 이중으로 확인한다.
const SEED_ACCOUNTS = [
  {
    handle: 'bob.hum.haneul',
    did: 'did:web:bob.hum.haneul',
    address: '0x8af0079f1c61849b3c5563ba123ed5413fcc05c8963fd0ecf81bd8220b067014',
    displayName: 'Bob 🐝',
    description: 'Humming creator — this profile is Haneul on-chain data',
    password: 'humming',
    // 크리에이터 신원·연령 인증 완료 (실서비스에선 KYC 절차 통과가 조건)
    verified: true,
  },
  {
    handle: 'alice.hum.haneul',
    did: 'did:web:alice.hum.haneul',
    address: '0xa5a8018f9eea5421ff6e9001bb0b8b502e5dd8d40265c38b728c3a1f5e5cf3f0',
    displayName: 'Alice ✨',
    description: 'Humming early subscriber',
    password: 'humming',
  },
  {
    // 전면 잠금 크리에이터 — 게시물 전체가 구독자 전용 (OnlyFans 스타일)
    handle: 'carol.hum.haneul',
    did: 'did:web:carol.hum.haneul',
    address: '0x721790f36e8ae1c71849c5b9897b2a9a150015da1ca37be20f74fbdea4580103',
    displayName: 'Carol 🌱',
    description: 'Subscribers-only profile — every post unlocks with a subscription',
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
    description: 'New on Humming',
    password: 'humming',
  },
  {
    // 단건 구매(PPV) 시연용 — 어떤 구독도 하지 않은 상태 유지
    handle: 'erin.hum.haneul',
    did: 'did:web:erin.hum.haneul',
    address: '0x454b30d5ca6c69048cf050368d3bf3c75fd7ed32427ac1c24b9d696dba9bd1a7',
    displayName: 'Erin 🌊',
    description: 'New on Humming',
    password: 'humming',
  },
]
const ACCOUNTS = IS_LOCALNET ? SEED_ACCOUNTS : []
const byHandle = h => ACCOUNTS.find(a => a.handle === h || a.did === h)
const byAddress = addr => ACCOUNTS.find(a => a.address === addr)
const byDid = d => ACCOUNTS.find(a => a.did === d)

// 가입으로 생긴 계정은 accounts 파일로 존속 (재시작 생존; 시드 계정과 병합).
// 네트워크별 분리 — 로컬넷 regenesis 청소가 메인넷 계정 파일을 건드리지 못하게 한다.
const ACCOUNTS_FILE = new URL(
  NETWORK === 'mainnet' ? './accounts.mainnet.json' : './accounts.json',
  import.meta.url,
)
try {
  for (const a of JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))) {
    if (!ACCOUNTS.some(x => x.handle === a.handle)) ACCOUNTS.push(a)
  }
} catch {}
// 계정 파일에는 비밀번호 해시가 들어가므로 소유자 전용(0600) — keys.mjs와 동일 규약
// 비밀번호 해시의 단일 원본 — keys.mjs와 같은 이유로 원자적으로 교체한다.
const persistAccounts = () => {
  writeFileAtomic(ACCOUNTS_FILE, JSON.stringify(ACCOUNTS.filter(a => a.signup), null, 2), {
    mode: 0o600,
  })
  noteBackupChange()
}
// ---- 배포 가드: 로컬넷 밖으로는 데모 전제를 하나도 끌고 나가지 못하게 한다 ----
// 시드 계정 비밀번호('humming')는 README·E2E에 공개된 값 — 실 체인에서 이 계정으로
// 부팅하면 임의의 공격자가 로그인해 지갑을 드레인할 수 있으므로 부팅 자체를 거부한다.
if (!IS_LOCALNET) {
  const fatal = []
  if (ACCOUNTS.some(a => a.password !== undefined))
    fatal.push(
      '시드 계정이 소스에 공개된 비밀번호를 갖고 있습니다 — ACCOUNTS의 데모 계정을 제거하세요.',
    )
  if (!process.env.HUMMING_PUBLIC_URL)
    fatal.push('HUMMING_PUBLIC_URL 미설정 — 미디어 서명 URL이 localhost로 발급되어 전부 404가 됩니다.')
  if (!process.env.HUMMING_APP_ORIGINS)
    fatal.push('HUMMING_APP_ORIGINS 미설정 — CORS가 모든 origin을 반사합니다. 앱 origin을 콤마로 지정하세요.')
  if (!process.env.HUMMING_KEYS_PASSPHRASE)
    fatal.push(
      'HUMMING_KEYS_PASSPHRASE 미설정 — 수탁 키 저장소가 평문으로 남습니다. 디스크/백업 유출 = 전 유저 자금 드레인.',
    )
  // 스폰서 금액 오설정(단위 착오 등)이 그대로 지출 상한이 되는 것을 막는다: 0 초과 ~ 10 HANEUL
  if (STARTER_GEUNHWA <= 0n || STARTER_GEUNHWA > 10_000_000_000n)
    fatal.push(
      `HUMMING_STARTER_GEUNHWA=${STARTER_GEUNHWA} — 가입 스타터 금액은 GEUNHWA 단위로 0 초과 10 HANEUL 이하여야 합니다.`,
    )
  if (fatal.length) {
    console.error(`❌ 비로컬넷 체인(${RPC_URL})으로 부팅 거부:`)
    for (const m of fatal) console.error(`   - ${m}`)
    process.exit(1)
  }
}

// ---- 체인 정체성 가드: URL이 localhost라는 것과 그 뒤가 로컬넷이라는 것은 다른 명제 ----
// 파사드를 메인넷 풀노드와 같은 박스에 두면 127.0.0.1이 곧 메인넷이다. 로컬넷 posture
// (시드 계정·완화된 리밋·faucet·CORS 개방)는 체인 식별자를 실제로 확인한 뒤에만 연다.
// 확인 자체가 안 되면(체인 다운) 열지 않는다 — 잘못된 posture로 서빙하느니 부팅 실패가 낫다.
if (IS_LOCALNET) {
  let chainId = null
  try {
    chainId = await chainIdentifier()
  } catch (e) {
    console.error(`❌ 체인 식별자 확인 실패(${RPC_URL}): ${e.message}`)
    console.error('   로컬넷 posture는 체인을 확인한 뒤에만 엽니다 — 로컬넷이 떠 있는지 확인하세요.')
    console.error('   배포 환경이라면 HUMMING_ENV=production 을 설정하세요.')
    process.exit(1)
  }
  if (chainId === MAINNET_CHAIN_ID) {
    console.error(`❌ ${RPC_URL} 은 localhost지만 그 뒤의 체인은 메인넷(${chainId})입니다.`)
    console.error('   시드 계정·완화된 레이트리밋을 메인넷에 노출할 수 없어 부팅을 거부합니다.')
    console.error('   HUMMING_ENV=production 을 설정하고 배포 요건(README)을 채워 다시 시작하세요.')
    process.exit(1)
  }
}

// 역방향 검증: NETWORK=mainnet 설정이면 실체인도 메인넷이어야 한다 — 메인넷 주소
// 상수를 엉뚱한 체인에 대고 서빙하면 조용히 빈 인덱스로 뜨는 것을 부팅 실패로 바꾼다.
if (NETWORK === 'mainnet') {
  let chainId = null
  try {
    chainId = await chainIdentifier()
  } catch (e) {
    console.error(`❌ 체인 식별자 확인 실패(${RPC_URL}): ${e.message} — 메인넷 RPC를 확인하세요.`)
    process.exit(1)
  }
  if (chainId !== MAINNET_CHAIN_ID) {
    console.error(`❌ HUMMING_NETWORK=mainnet 인데 ${RPC_URL} 의 체인은 ${chainId} 입니다.`)
    process.exit(1)
  }
}

// 평문 password → scrypt 해시 1회 마이그레이션. 시드 계정의 소스 리터럴은 데모 공개
// 비밀번호(E2E·README에 문서화)라 유지하되, 런타임 메모리·디스크에는 해시만 남긴다.
{
  let migrated = false
  for (const a of ACCOUNTS) {
    if (a.password !== undefined) {
      a.passwordHash = await hashPassword(a.password)
      delete a.password
      if (a.signup) migrated = true
    }
  }
  if (migrated) persistAccounts()
}

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
  const dfs = await listAllDynamicFields(NS_OBJ)
  // RegistryKey<..denylist::Denylist>도 같은 부모에 있으므로 Registry 본체 키를 정확히 집는다
  const reg = dfs.find(d => (d.name?.type || '').includes('::registry::Registry>'))
  const json = await getObjectJson(reg.fieldId)
  nsRegistryTable = deepFind(json, 'registry').id
  return nsRegistryTable
}
// 이름으로 동적 필드 조회 — gRPC에는 이름 조회 RPC가 없어 SDK가 필드 ID를
// 유도(deriveDynamicFieldID)해 객체를 읽는다. 반환은 필드 객체의 평면 json, 부재는 null.
async function dynamicFieldId(parentId, nameType, nameBcs) {
  try {
    const { dynamicField } = await grpcClient.getDynamicField({
      parentId,
      name: { type: nameType, bcs: nameBcs },
    })
    return dynamicField.fieldId
  } catch (e) {
    if (/not.?found/i.test(String(e?.message))) return null
    throw e
  }
}
async function dynamicFieldJson(parentId, nameType, nameBcs) {
  const id = await dynamicFieldId(parentId, nameType, nameBcs)
  return id ? getObjectJson(id) : null
}
const DomainBcs = bcs.struct('Domain', { labels: bcs.vector(bcs.string()) })
// 메인넷 denylist — reserved(브랜드·시스템 예약 3,824)·blocked(피싱·유해 36) 라벨 가입 거부.
// 온체인 new_leaf는 NFT 소유자 발급 경로라 denylist를 강제하지 않음 — 파사드가 집행 지점.
// 조회 실패는 거부로 처리(fail-closed): 확인 못 한 이름을 발급하지 않는다.
async function isDeniedName(label) {
  if (!DENY_RESERVED_TABLE) return false
  const name = bcs.string().serialize(label).toBytes()
  for (const table of [DENY_BLOCKED_TABLE, DENY_RESERVED_TABLE]) {
    if (await dynamicFieldId(table, '0x1::string::String', name)) return true
  }
  return false
}
// 'grace.hum.haneul' → 레지스트리 테이블에서 NameRecord 조회 (labels는 TLD-first).
// strict=false: 조회 실패를 부재(null)로 뭉갠다 (읽기 경로의 관용 동작).
// strict=true: 실패를 그대로 던진다. 가입 화해처럼 "부재 확인"이 지갑 롤백의
// 근거가 되는 곳은 실패와 부재를 구분해야 한다.
async function chainNameRecord(handle, { strict = false } = {}) {
  const labels = String(handle || '').toLowerCase().split('.').reverse()
  if (labels.length < 2 || labels[0] !== 'haneul') return null
  try {
    const table = await getNsRegistryTable()
    const rec = await dynamicFieldJson(
      table,
      `${NS_PKG}::domain::Domain`,
      DomainBcs.serialize({ labels }).toBytes(),
    )
    const target = deepFind(rec, 'target_address')
    if (target === undefined) return null
    return { target }
  } catch (e) {
    if (strict) throw e
    return null
  }
}

// ---- 인증: HS256 실서명 JWT (lib/auth) ----
const httpError = (status, errorName, message) => {
  const e = new Error(message)
  e.status = status
  e.errorName = errorName
  throw e
}
// 토큰이 없으면 익명(null) — 읽기 엔드포인트는 익명 허용. 토큰이 있으면 반드시
// 유효해야 하며, 위조·변조는 익명으로 강등하지 않고 거부한다. 만료는 400 ExpiredToken —
// 앱(@atproto/api 에이전트)이 이 에러명을 보고 refreshSession을 자동 호출하는 규약.
function didFromAuth(req) {
  const header = req.headers.authorization
  if (!header) return null
  const token = header.replace(/^Bearer /, '')
  const payload = verifyJwt(token)
  if (!payload || payload.scope !== 'com.atproto.access')
    httpError(401, 'InvalidToken', 'Invalid access token')
  // deleteSession으로 폐기된 세션의 토큰은 서명이 유효해도 거부한다
  // (jti 공유 폐기, 구형 무-jti 토큰은 해시로)
  if (isRevoked(payload.jti) || (!payload.jti && isRevoked(tokenId(token))))
    httpError(401, 'InvalidToken', 'Session has been revoked')
  if (payload.exp <= Math.floor(Date.now() / 1000))
    httpError(400, 'ExpiredToken', 'Access token has expired')
  return payload.sub
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
let postCacheVersion = -1
// 인덱서의 PostCreated 전량(오름차순)을 최신순 게시물 뷰로 변환 — RPC 0회.
// 인덱스 버전이 같으면 캐시 재사용 (fakeCid sha256 재계산 방지). 미디어 embed는
// 만료형 서명 URL이라 캐시에 넣지 않고 응답 시점(gatePosts)에 자격자에게만 생성.
// 캐시 항목은 요청 간 공유되므로 소비자는 불변으로 다뤄야 한다.
async function loadPosts() {
  if (postCacheVersion === stateVersion()) return postCache
  const version = stateVersion() // 빌드 중 새 이벤트가 오면 다음 요청이 다시 빌드
  const mapped = await Promise.all(
    chainState.posts.toReversed().map(async ev => {
      const p = ev.parsedJson
      const acct = byAddress(p.author)
      if (!acct) return null
      const createdAt = new Date(ev.timestampMs).toISOString()
      const { text, media, langs } = decodeContent(p.content_uri)
      return {
        postId: String(p.post_id),
        repliedTo: p.replied_to,
        author: acct,
        media,
        post: {
          uri: `at://${acct.did}/app.bsky.feed.post/${p.post_id}`,
          cid: await fakeCid(ev.txDigest),
          author: profileBasic(acct),
          record: {
            $type: 'app.bsky.feed.post',
            text,
            createdAt,
            // 언어는 컴포저 선택값이 content_uri에 실려 온 것 — 없으면 필드 생략
            ...(langs.length ? { langs } : {}),
          },
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
  const cache = mapped.filter(Boolean)
  // reply counts
  for (const item of cache) {
    if (item.repliedTo != null) {
      const parent = cache.find(x => x.postId === String(item.repliedTo))
      if (parent) parent.post.replyCount++
    }
  }
  postCache = cache
  postCacheVersion = version
  return postCache
}

// ---- paywall & subscription state — 인덱서의 전량 인메모리 상태에서 파생 ----
const loadGateState = () => gateView()

// ---- 미디어 소유 바인딩 ----
// CID는 온체인 공개 데이터라 누구나 수집할 수 있다. 서명 URL 발급을 "그 CID의
// 소유자가 쓴 게시물"로 한정해, 남의 유료 CID를 자기(잠기지 않은) 글에 embed해
// 페이월을 우회하는 경로를 차단한다. 소유자 판정은 이중이다:
//   ① 업로드 시 meta.json에 기록된 owner (이 커밋 이후의 업로드, 근거가 가장 강함)
//   ② 없으면 체인에서 그 CID가 처음 등장한 게시물의 작성자 (과거 업로드 백필 —
//      공격자의 embed는 언제나 원본 게시물보다 나중의 post_id를 가지므로 안전)
const mediaMetaOwners = new Map() // cid → address | null (meta.json 조회 캐시)
function metaOwnerOf(cid) {
  if (mediaMetaOwners.has(cid)) return mediaMetaOwners.get(cid)
  let owner = null
  try {
    owner = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, `${cid}.meta.json`), 'utf8')).owner ?? null
  } catch {}
  mediaMetaOwners.set(cid, owner)
  return owner
}
let cidOwnerVersion = -1
let cidFirstAuthor = new Map() // cid → 첫 등장 게시물의 작성자 주소
function chainFirstAuthorOf(cid) {
  if (cidOwnerVersion !== postCacheVersion) {
    cidFirstAuthor = new Map()
    // postCache는 최신순 — post_id 오름차순으로 돌며 첫 등장 작성자를 기록
    for (const item of [...postCache].sort((a, b) => Number(a.postId) - Number(b.postId))) {
      for (const m of item.media) {
        if (!cidFirstAuthor.has(m.cid)) cidFirstAuthor.set(m.cid, item.author.address)
      }
    }
    cidOwnerVersion = postCacheVersion
  }
  return cidFirstAuthor.get(cid)
}
const mediaOwnedBy = (item) =>
  item.media.filter(m => (metaOwnerOf(m.cid) ?? chainFirstAuthorOf(m.cid)) === item.author.address)

// 비열람 자격 뷰어에게는 본문 대신 잠금 정보를 내려줌.
// post.humming 마커(구조화)로 humming-app이 네이티브 잠금 카드를 그리고,
// record.text 대체문은 무수정 Bluesky 클라이언트용 폴백.
function gatePosts(posts, viewerAcct, gate) {
  return posts.map(item => {
    const viewer = viewerAcct?.address
    const isAuthor = viewer === item.author.address
    const subscribed = !!viewer && gate.isSubscribedTo(viewer, item.author.address)
    const pw = gate.paywallByPost.get(item.postId)
    const purchasedThis = !!viewer && gate.purchased.has(`${item.postId}:${viewer}`)
    const paywallLocked = pw && !isAuthor && !subscribed && !purchasedThis
    const prefs = gate.prefsOf(item.author.address)
    // 단건 구매는 전면 잠금도 뚫는다 — 크리에이터가 이 포스트에 개별 가격을
    // 붙여 판 이상, 구매자에게 안 보여주면 돈만 받고 콘텐츠를 안 준 상태가 된다
    const profileLocked = prefs.locked && !isAuthor && !subscribed && !purchasedThis
    if (!paywallLocked && !profileLocked) {
      // 자격자에게만 이 시점에 미디어 서명 URL 발급 (캐시엔 embed가 아예 없음 —
      // 잠금의 실체는 "서버가 안 주는 것", 만료형 URL이 캐시에서 썩지도 않음).
      // 작성자가 소유한 CID만 발급 — 훔쳐온 CID는 조용히 떨어진다
      if (!item.media.length) return item
      const embed = imagesEmbedView(mediaOwnedBy(item))
      return embed ? { ...item, post: { ...item.post, embed } } : item
    }
    const tier = gate.tierByCreator.get(item.author.address) || null
    const priceH = pw ? Number(pw.price) / 1e9 : null
    // 비자격자에겐 개수/종류만 티저로 남긴다 (전환 유도, OnlyFans와 동일한 메커니즘)
    return {
      ...item,
      post: {
        ...item.post,
        humming: {
          locked: true,
          reason: paywallLocked ? 'paywall' : 'profile',
          // 전면 잠금 크리에이터의 프로필 피드 노출 방식 (온체인 설정)
          previews: prefs.previews,
          priceGeunhwa: pw ? Number(pw.price) : null,
          tier: tier ? { priceGeunhwa: tier.priceGeunhwa, periodMs: tier.periodMs } : null,
          media: mediaCounts(mediaOwnedBy(item)),
        },
        record: {
          ...item.post.record,
          text: paywallLocked
            ? `🔒 Subscribers-only post\n\nSubscribe to @${item.author.handle} or buy this post (${priceH} HANEUL) to view it. Access is verified by the on-chain subscription state on Haneul.`
            : `🔒 Posts from @${item.author.handle} are visible to subscribers only.`,
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
// 리버스 프록시(nginx 등) 뒤에서만 X-Forwarded-For를 신뢰 — 직노출 시 켜면 IP 스푸핑으로
// 레이트리밋을 우회할 수 있으므로 기본 off, 배포 구성에서 명시적으로 켠다
// 값 = 신뢰할 프록시 홉 수 (예: Cloudflare→로컬 Caddy→파사드면 2). 미설정이면 불신.
{
  const hops = Number(process.env.HUMMING_TRUST_PROXY)
  if (Number.isInteger(hops) && hops > 0) app.set('trust proxy', hops)
}
// 배포 가드가 비로컬넷에서 HUMMING_APP_ORIGINS를 강제 — 로컬넷 개발만 전체 반사 허용
const APP_ORIGINS = (process.env.HUMMING_APP_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
app.use(cors({ origin: APP_ORIGINS.length ? APP_ORIGINS : true, allowedHeaders: '*', exposedHeaders: '*' }))
app.use(express.json({ limit: '5mb' }))

// ---- ready 게이트: 인덱스 복원이 끝나기 전엔 아무 XRPC도 응답하지 않는다 (fail-closed) ----
// 복원 도중엔 포스트는 있는데 페이월·프리프가 아직인 창이 생길 수 있다 — 그 창에서
// 잠금 판정이 false가 되어 유료 본문·서명 미디어 URL이 익명 뷰어에게 누출된다.
// 제품이 지키겠다고 약속한 바로 그 콘텐츠이므로 503이 정답.
let chainReady = false
app.use('/xrpc', (req, res, next) => {
  if (chainReady) return next()
  res.setHeader('Retry-After', '2')
  res.status(503).json({ error: 'ServiceUnavailable', message: 'Warming up: chain index backfill in progress' })
})
// 테일링 랙 임계: 이보다 오래 스트림이 침묵하면 인덱스가 낡아지고 있다고 본다.
// degraded여도 200은 유지한다 (LB가 노드를 뺐다 넣었다 하는 플래핑 방지),
// 모니터링은 degraded 필드와 lagSeconds를 본다.
const TAILING_DEGRADED_S = Number(process.env.HUMMING_TAILING_DEGRADED_S ?? 120)
app.get('/health', (req, res) => {
  const t = tailingHealth()
  const degraded = chainReady && (t.lagSeconds == null || t.lagSeconds > TAILING_DEGRADED_S)
  res.status(chainReady ? 200 : 503).json({
    ready: chainReady,
    ...(chainReady && { events: stats(), ...t, degraded }),
  })
})

// ---- 인증 표면 레이트리밋 ----
// 로컬넷은 리밋을 사실상 풀어 E2E·반복 개발을 막지 않는다 (기제 자체는 동일 코드로 통과).
// createSession: 커스터디 지갑의 유일한 방벽이 비밀번호 — 무제한 추측을 막는다.
// per-IP(광역 스캔)와 per-계정(단일 표적 분산 IP) 양쪽에서 조인다.
const limitOf = (envKey, prod) => Number(process.env[envKey] ?? (IS_LOCALNET ? 10_000 : prod))
app.use(
  '/xrpc/com.atproto.server.createSession',
  rateLimit({ windowMs: 5 * 60_000, max: limitOf('HUMMING_LOGIN_IP_LIMIT', 20) }),
  rateLimit({
    windowMs: 15 * 60_000,
    max: limitOf('HUMMING_LOGIN_ACCT_LIMIT', 10),
    key: req => (req.body?.identifier ? `acct:${String(req.body.identifier).toLowerCase()}` : null),
    message: 'Too many login attempts for this account — try again later',
  }),
)
// createAccount: 가입마다 faucet + APP_WALLET 가스가 나가는 지출 엔드포인트 —
// per-IP에 더해 일일 총량 cap으로 지갑 드레인의 상한을 건다.
app.use(
  '/xrpc/com.atproto.server.createAccount',
  rateLimit({
    windowMs: 60 * 60_000,
    max: limitOf('HUMMING_SIGNUP_IP_LIMIT', 5),
    message: 'Too many signups from this address — try again later',
  }),
  rateLimit({
    windowMs: 24 * 60 * 60_000,
    max: limitOf('HUMMING_MAX_SIGNUPS_PER_DAY', 200),
    key: () => 'global',
    error: 'SignupsPaused',
    message: 'Signups are paused for today — please come back tomorrow',
  }),
)

// ---- 지출·쓰기 엔드포인트 per-계정 레이트리밋 ----
// 결제(구독/구매/팁)와 온체인 쓰기(글 작성)는 요청마다 실제 tx 비용이 나간다.
// 키는 토큰의 계정(did): 로그인 표면과 달리 인증 뒤 표면이라 계정 단위가 정확하고,
// 토큰이 없거나 깨진 요청은 IP로 묶는다 (어차피 핸들러의 인증에서 거부된다).
const acctKey = req => {
  const payload = verifyJwt((req.headers.authorization || '').replace(/^Bearer /, ''))
  return payload?.sub ? `did:${payload.sub}` : req.ip
}
const moneyLimiter = rateLimit({
  windowMs: 60_000,
  max: limitOf('HUMMING_MONEY_ACCT_LIMIT', 10),
  key: acctKey,
  message: 'Too many payment requests, slow down and try again',
})
for (const nsid of [
  'app.humming.monetization.subscribe',
  'app.humming.monetization.purchasePost',
  'app.humming.monetization.tip',
]) app.use(`/xrpc/${nsid}`, moneyLimiter)
const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: limitOf('HUMMING_WRITE_ACCT_LIMIT', 30),
  key: acctKey,
  message: 'Too many writes, slow down and try again',
})
for (const nsid of ['com.atproto.repo.applyWrites', 'com.atproto.repo.createRecord'])
  app.use(`/xrpc/${nsid}`, writeLimiter)

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
  // 정책은 신규 생성에만 강제한다. 로그인(createSession)에 걸면 기존 유저가 잠긴다.
  const pwProblem = checkNewPassword(password)
  if (pwProblem) fail(400, 'InvalidPassword', pwProblem)
  const h = String(handle).toLowerCase()
  if (!h.endsWith('.hum.haneul')) fail(400, 'UnsupportedDomain', 'handle must end with .hum.haneul')
  const name = h.slice(0, -'.hum.haneul'.length)
  // 온체인 제약과 동일: SubDomainConfig min_label_size=3, 라벨 문자셋
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(name))
    fail(400, 'InvalidHandle', 'Nicknames must be 3-30 characters of lowercase letters, digits, or hyphens')
  if (byHandle(h)) fail(400, 'HandleNotAvailable', 'This nickname is already taken')
  if (await chainNameRecord(h)) fail(400, 'HandleNotAvailable', 'This nickname is already registered on-chain')
  if (await isDeniedName(name)) fail(400, 'HandleNotAvailable', 'This nickname is reserved')

  // ① 새 지갑 — 인프로세스 키 생성, 파사드 키 저장소에 등록 (비수탁 전환 전까지의 수탁 데모)
  const { address } = createWallet()
  // 체인 등록 성공 후 ACCOUNTS 기록 전에 죽으면 "고아 지갑 + 영구 소진 핸들"이 남는다:
  // 체인 호출 전에 pending으로 남겨 부팅 화해(reconcileSignups)가 계정을 입양하게 한다
  const passwordHash = await hashPassword(password)
  addPendingSignup({ handle: h, address, passwordHash, ts: Date.now() })
  try {
    if (IS_LOCALNET) {
      // ② 가스 지급(로컬넷 faucet) ③ 닉네임 발급 — hum.haneul 부모 NFT 소유자(앱 지갑)가
      //    서명·가스 부담. APP_WALLET 서명 tx끼리만 직렬화되고 다른 지갑의 결제와는 병렬
      await faucet(address)
      await execTx(APP_WALLET, buildNewLeaf(h, address))
    } else {
      // faucet 없는 체인: 닉네임 발급 + 스타터 가스를 APP_WALLET의 한 PTB로 원자 처리 —
      // "이름만 등록된 무가스 지갑" 부분 실패 창이 없고, 지출 상한은 가입 레이트리밋이 건다
      await execTx(APP_WALLET, tx => {
        buildNewLeaf(h, address)(tx)
        buildStarterGas(address, STARTER_GEUNHWA)(tx)
      })
    }
  } catch (e) {
    // 온체인 등록 실패(동시 가입으로 leaf 선점 등) → 방금 만든 키 롤백, 고아 키 방지
    removeWallet(address)
    removePendingSignup(h)
    throw e
  }
  const acct = {
    handle: h,
    did: `did:web:${h}`,
    address,
    displayName: name,
    description: 'New on Humming',
    passwordHash,
    signup: true,
  }
  ACCOUNTS.push(acct)
  persistAccounts()
  removePendingSignup(h)
  console.log(`🐣 가입: ${acct.handle} → 지갑 ${acct.address.slice(0, 10)}… (온체인 leaf 등록)`)
  return {
    ...sessionTokens(acct.did),
    handle: acct.handle,
    did: acct.did,
  }
})

xrpc('post', 'com.atproto.server.createSession', async req => {
  const { identifier, password } = req.body
  const acct = byHandle(identifier)
  // 계정 부재와 비밀번호 불일치를 구분하지 않음 — 계정 존재 여부 누설 방지.
  // 미지 계정도 DUMMY_HASH에 대고 같은 scrypt 비용을 치러 응답 시간마저 동일하다.
  const ok = await verifyPassword(password, acct?.passwordHash ?? DUMMY_HASH)
  if (!acct || !ok) {
    const e = new Error('Invalid identifier or password')
    e.status = 401
    throw e
  }
  console.log(`✅ 로그인: ${acct.handle}`)
  return {
    ...sessionTokens(acct.did),
    handle: acct.handle,
    did: acct.did,
    email: `${acct.handle.split('.')[0]}@humming.local`,
    emailConfirmed: true,
    active: true,
  }
})

// refresh 스코프 토큰만 수용 — access 토큰으로 세션을 연장할 수 없다
xrpc('post', 'com.atproto.server.refreshSession', req => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  const payload = verifyJwt(token)
  if (!payload || payload.scope !== 'com.atproto.refresh')
    httpError(401, 'InvalidToken', 'Valid refresh token required')
  if (isRevoked(payload.jti) || (!payload.jti && isRevoked(tokenId(token))))
    httpError(401, 'InvalidToken', 'Session has been revoked')
  if (payload.exp <= Math.floor(Date.now() / 1000))
    httpError(400, 'ExpiredToken', 'Refresh token has expired')
  const acct = byDid(payload.sub)
  if (!acct) httpError(401, 'InvalidToken', 'Unknown account')
  return {
    ...sessionTokens(acct.did),
    handle: acct.handle,
    did: acct.did,
    active: true,
  }
})

// 로그아웃: 이 세션의 access/refresh 쌍을 폐기 목록에 올린다 (영속, 재시작 생존).
// ATProto 규약상 refresh 토큰으로 호출되지만, access 토큰이 와도 같은 jti를
// 폐기하므로 결과는 동일하다. 만료된 토큰의 폐기 요청도 수용한다 (해가 없다).
xrpc('post', 'com.atproto.server.deleteSession', req => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  const payload = verifyJwt(token)
  if (!payload || !['com.atproto.refresh', 'com.atproto.access'].includes(payload.scope))
    httpError(401, 'InvalidToken', 'Valid session token required')
  revokeSession(payload.jti || tokenId(token))
  console.log(`👋 로그아웃: ${payload.sub}`)
  return {}
})

xrpc('get', 'com.atproto.server.getSession', req => {
  const acct = requireAuthAcct(req)
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
  // 계정 전환기가 브라우저에 저장된 전 계정을 한 번에 조회한다 — 지난 체인(regenesis
  // 이전)의 계정 등 모르는 actor가 섞여도 전체를 실패시키지 않고 아는 것만 반환
  // (실제 appview와 동일한 관용 동작)
  const profiles = await Promise.all(actors.map(a => detailedProfile(a).catch(() => null)))
  return { profiles: profiles.filter(Boolean) }
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
// 타임라인·피드 공용 페이지 응답: 전량이 아니라 요청 페이지만 게이팅해 서빙한다.
// 게이팅(서명 미디어 URL 발급 포함)을 슬라이스 뒤에 하므로 비용이 페이지 크기에
// 비례하고, 잠금 판정은 항목 단위라 페이지별 적용이 전체 적용과 동일하다.
async function pagedTimeline(req, label) {
  const [posts, gate] = await Promise.all([loadPosts(), loadGateState()])
  const limit = clampLimit(req.query.limit)
  const { items, cursor } = pagePosts(posts, limit, req.query.cursor)
  const page = gatePosts(items, byDid(didFromAuth(req)), gate)
  console.log(`📜 ${label} → 온체인 게시물 ${page.length}/${posts.length}개 서빙`)
  return { feed: page.map(p => ({ post: p.post })), ...(cursor ? { cursor } : {}) }
}
xrpc('get', 'app.bsky.feed.getTimeline', req => pagedTimeline(req, 'getTimeline'))
// 비로그인 랜딩(Discover)이 요청하는 feedgen 뷰: 어떤 feed URI가 오든
// 같은 공개 타임라인을 돌려준다(익명 게이팅 동일 적용). 앱의 loggedOutFetch가
// 여기로 오면서 실제 Bluesky 콘텐츠가 첫 화면에 노출되던 문제의 서버 측 짝.
// "내 피드"의 커스텀 피드 요청도 이 라우트 하나가 처리한다.
xrpc('get', 'app.bsky.feed.getFeed', req => pagedTimeline(req, 'getFeed'))
xrpc('get', 'app.bsky.feed.getAuthorFeed', async req => {
  const acct = byHandle(req.query.actor) || byDid(req.query.actor)
  const [posts, gate] = await Promise.all([loadPosts(), loadGateState()])
  // 작성자 필터·previews 숨김은 게이팅 결과에 의존하므로 슬라이스보다 먼저 적용한다
  // (작성자 글만 게이팅하니 비용은 그 계정의 글 수에 비례)
  const visible = gatePosts(
    posts.filter(p => acct && p.author.did === acct.did),
    byDid(didFromAuth(req)),
    gate,
  )
    // 온체인 설정 previews=false인 크리에이터는 비구독자 프로필 피드에서 글을 통째로 숨김
    // (담벼락 패널은 앱이 렌더). previews=true면 잠금 카드로 노출
    .filter(p => !(p.post.humming?.reason === 'profile' && !p.post.humming?.previews))
  const { items, cursor } = pagePosts(visible, clampLimit(req.query.limit), req.query.cursor)
  return { feed: items.map(p => ({ post: p.post })), ...(cursor ? { cursor } : {}) }
})
// 스레드 답글 상한: 답글이 무제한이면 스레드 뷰가 타임라인 페이지네이션을 우회하는
// 전량 덤프 표면이 된다 (최신 답글 우선이 아닌 오름차순 유지, 앞에서 자름)
const THREAD_REPLY_LIMIT = 100
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
        .slice(0, THREAD_REPLY_LIMIT)
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
  const replies = posts.filter(p => p.repliedTo != null && String(p.repliedTo) === anchor.postId)
  for (const r of replies.slice(0, THREAD_REPLY_LIMIT)) {
    thread.push(item(r, 1))
  }
  return { thread, hasOtherReplies: replies.length > THREAD_REPLY_LIMIT }
})
xrpc('get', 'app.bsky.unspecced.getPostThreadOtherV2', () => ({ thread: [] }))
// 탐색/프로필 부가 화면 스텁
xrpc('get', 'app.bsky.feed.getActorFeeds', () => ({ feeds: [] }))
xrpc('get', 'app.bsky.unspecced.getTrends', () => ({ trends: [] }))
xrpc('get', 'app.bsky.unspecced.getSuggestedUsersForExplore', () => ({ actors: [] }))
xrpc('get', 'app.bsky.unspecced.getSuggestedStarterPacks', () => ({ starterPacks: [] }))
xrpc('get', 'app.bsky.unspecced.getOnboardingSuggestedStarterPacks', () => ({ starterPacks: [] }))
// 온보딩 3단계 "나를 위한 추천" — 시드·가입 계정을 그대로 추천 (카테고리는 무시, 계정 풀이 작음)
xrpc('get', 'app.bsky.unspecced.getSuggestedOnboardingUsers', req => {
  const viewer = byDid(didFromAuth(req))
  const limit = Number(req.query.limit) || 10
  const actors = ACCOUNTS.filter(a => a.did !== viewer?.did)
    .slice(0, limit)
    .map(a => ({ ...profileBasic(a), description: a.description }))
  return { actors, recIdStr: 'humming-seed' }
})
xrpc('get', 'app.bsky.draft.getDrafts', () => ({ drafts: [] }))
xrpc('get', 'chat.bsky.convo.getConvoAvailability', () => ({ canChat: false }))
xrpc('get', 'app.bsky.unspecced.getSuggestedFeeds', () => ({ feeds: [] }))
// (getFeed 중복 등록 제거: express는 먼저 등록된 라우트가 응답하므로 위의
// getFeed(discover) 하나가 "내 피드"의 커스텀 피드 요청까지 전부 처리한다)

// --- writes: app → facade → SDK Transaction → chain ---
// 직렬화는 lib/chain의 per-address 큐가 담당 — 지갑이 다르면 완전 병렬

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

async function submitPostOnChain(acct, text, parentId, media, paywallGeunhwa, langs) {
  // 본문 길이 상한: 앱은 300 grapheme에서 자르지만 API 직접 호출은 무제한이었다
  if (String(text ?? '').length > MAX_POST_TEXT_CHARS)
    httpError(400, 'InvalidRequest', `Post text must be at most ${MAX_POST_TEXT_CHARS} characters`)
  // 페이월 가격은 서버가 재검증 (클라이언트 값 신뢰 금지): 0.01~100 HANEUL
  const paywall =
    Number.isFinite(Number(paywallGeunhwa)) &&
    Number(paywallGeunhwa) >= 10_000_000 &&
    Number(paywallGeunhwa) <= 100_000_000_000
      ? Math.floor(Number(paywallGeunhwa))
      : null
  // 글 작성과 페이월 생성을 한 tx로 원자 확정 — 가격 없는 유료 글이 생길 틈이 없음
  const { digest, events } = await execTx(
    acct.address,
    buildCreatePost(encodeContent(text, media, langs), parentId, paywall),
    'PostCreated',
  )
  const postId = String(
    events.find(e => e.type === `${PKG}::feed::PostCreated`).parsedJson.post_id,
  )
  if (paywall && !events.some(e => e.type.endsWith('::PaywallCreated')))
    throw new Error(`Paywall creation failed (tx: ${digest})`)
  console.log(
    `⛓️  쓰기: post_id=${postId} by ${acct.handle}${paywall ? ` [유료 ${paywall / 1e9} HANEUL]` : ''} tx=${digest}`,
  )
  return { postId, digest }
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

// ---- 업로드 용량 쿼터 ----
// 계정당 저장 바이트 상한. 최초 요청 때 meta.json을 훑어 집계를 만들고 이후 증분 유지.
const MEDIA_QUOTA_BYTES = Number(process.env.HUMMING_MEDIA_QUOTA_BYTES ?? 512 * 1024 * 1024)
let mediaUsage = null // address → 저장 바이트 합
function mediaUsageMap() {
  if (mediaUsage) return mediaUsage
  mediaUsage = new Map()
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    if (!f.endsWith('.meta.json')) continue
    try {
      const m = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, f), 'utf8'))
      if (m.owner) mediaUsage.set(m.owner, (mediaUsage.get(m.owner) || 0) + (Number(m.size) || 0))
    } catch {}
  }
  return mediaUsage
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
      // 저장·반사되는 Content-Type은 화이트리스트만: 임의 타입을 받으면 우리 origin에서
      // text/html 등을 서빙하는 서명 URL이 만들어진다 (svg 포함 스크립트 계열 차단)
      if (!isAllowedMediaMime(mime))
        return res.status(400).json({
          error: 'InvalidMimeType',
          message: 'Only image/* and video/* uploads are supported',
        })
      // 실제 PDS와 동일하게 blob CID = raw(0x55) + sha256 — 파일 내용이 곧 주소
      const digest = await sha256.digest(bytes)
      const cid = CID.createV1(0x55, digest).toString()
      // CID는 내용 주소 — 반쯤 쓰인 블롭이 그 주소로 서빙되는 일이 없게 원자적으로 쓴다.
      // owner는 최초 업로더로 고정: 같은 파일을 나중에 올린 사람이 소유권을 뺏지 못한다
      let owner = acct.address
      let isNewBlob = true
      try {
        const prev = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, `${cid}.meta.json`), 'utf8'))
        if (prev.owner) owner = prev.owner
        isNewBlob = false // 동일 내용 재업로드: 저장량이 늘지 않으므로 쿼터에 다시 안 센다
      } catch {}
      const usage = mediaUsageMap()
      if (isNewBlob && (usage.get(owner) || 0) + bytes.length > MEDIA_QUOTA_BYTES)
        return res.status(400).json({
          error: 'QuotaExceeded',
          message: 'Media storage quota exceeded for this account',
        })
      mediaMetaOwners.set(cid, owner)
      writeFileAtomic(path.join(MEDIA_DIR, cid), bytes, { mode: 0o644 })
      writeFileAtomic(path.join(MEDIA_DIR, `${cid}.meta.json`), JSON.stringify({ mime, size: bytes.length, owner }), { mode: 0o644 })
      if (isNewBlob) usage.set(owner, (usage.get(owner) || 0) + bytes.length)
      console.log(`📦 업로드: ${cid.slice(0, 16)}… (${mime}, ${bytes.length}B) by ${acct.handle}`)
      res.json({ blob: { $type: 'blob', ref: { $link: cid }, mimeType: mime, size: bytes.length } })
    } catch (e) {
      console.error('[uploadBlob] ERROR:', e.message)
      res
        .status(e.status || 500)
        .json({ error: e.errorName || 'InternalServerError', message: e.message })
    }
  },
)
implemented['com.atproto.repo.uploadBlob'] = true

// 서명 URL 검증 후에만 원본 서빙 — URL 없이 CID만 알아도 접근 불가
app.get('/media/:cid', (req, res) => {
  const { cid } = req.params
  const { exp, sig } = req.query
  if (!/^[a-z2-7]+$/.test(cid)) return res.status(400).end()
  // 서명 비교는 상수시간으로 (!== 는 앞자리부터 맞춰가는 타이밍 오라클)
  if (!exp || Number(exp) < Date.now() || !safeEqual(sig, signMedia(cid, exp))) {
    return res.status(403).json({ error: 'Forbidden', message: 'Missing or expired media URL signature' })
  }
  const file = path.join(MEDIA_DIR, cid)
  if (!fs.existsSync(file)) return res.status(404).end()
  // 화이트리스트 이전에 저장된 임의 타입이 남아 있어도 브라우저가 스니핑으로
  // 실행형 타입으로 승격하지 못하게 한다
  res.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    const meta = JSON.parse(fs.readFileSync(`${file}.meta.json`, 'utf8'))
    if (isAllowedMediaMime(meta.mime)) res.setHeader('Content-Type', meta.mime)
    else res.setHeader('Content-Type', 'application/octet-stream')
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
  const writes = req.body.writes || []
  // 요청당 쓰기 수 상한: 한 요청이 온체인 tx를 무제한으로 만들 수 없게 한다
  if (writes.length > MAX_APPLY_WRITES)
    httpError(400, 'InvalidRequest', `applyWrites accepts at most ${MAX_APPLY_WRITES} writes per request`)
  const results = []
  for (const w of writes) {
    const isCreate = (w.$type || '').endsWith('#create')
    if (isCreate && w.collection === 'app.bsky.feed.post') {
      const parentId = parentIdFromUri(w.value?.reply?.parent?.uri)
      const media = mediaFromEmbed(w.value?.embed)
      const { postId, digest } = await submitPostOnChain(acct, w.value?.text, parentId, media, w.value?.humming?.paywallGeunhwa, w.value?.langs)
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
    const { postId, digest } = await submitPostOnChain(acct, record?.text, parentId, media, record?.humming?.paywallGeunhwa, record?.langs)
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

// 프로필 저장(온보딩 마지막 단계·프로필 편집)은 계정 메타데이터에 반영, 그 외엔 수용만
xrpc('post', 'com.atproto.repo.putRecord', async req => {
  const acct = requireAuthAcct(req)
  const { collection, rkey, record } = req.body
  if (collection === 'app.bsky.actor.profile') {
    // 길이 상한은 앱의 프로필 편집 화면과 동일 (64/256), 초과는 API 직접 호출뿐
    if (typeof record?.displayName === 'string' && record.displayName.length > MAX_DISPLAY_NAME_CHARS)
      httpError(400, 'InvalidRequest', `displayName must be at most ${MAX_DISPLAY_NAME_CHARS} characters`)
    if (typeof record?.description === 'string' && record.description.length > MAX_DESCRIPTION_CHARS)
      httpError(400, 'InvalidRequest', `description must be at most ${MAX_DESCRIPTION_CHARS} characters`)
    if (record?.displayName) acct.displayName = record.displayName
    if (record?.description !== undefined) acct.description = record.description || ''
    if (acct.signup) persistAccounts()
  } else {
    console.log(`   (putRecord: ${collection} 미매핑 — 수용만)`)
  }
  return {
    uri: `at://${acct.did}/${collection}/${rkey || 'self'}`,
    cid: await fakeCid(acct.did + collection + JSON.stringify(record ?? {})),
  }
})

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

// 결제 연산 감사 래퍼: 연산 1건당 요청 ID를 발급하고 성공(digest 포함)·실패를
// 감사 로그(lib/audit)에 한 줄씩 남긴다. 실패도 남아야 중복 결제 분쟁을 재구성한다.
async function auditedMoney(op, viewer, fields, fn) {
  const reqId = newRequestId()
  const base = { reqId, op, did: viewer.did, address: viewer.address, ...fields }
  try {
    const result = await fn()
    auditMoney({ ...base, digest: result.digest, ...(result.prior && { prior: true }), outcome: 'success' })
    return result
  } catch (e) {
    auditMoney({ ...base, outcome: 'error', error: e.message })
    throw e
  }
}

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
  // 이미 구독 중이면 새 트랜잭션을 만들지 않는다 — 늦은 재시도·중복 제출이
  // 두 번째 결제가 되는 것을 온체인 상태로 차단 (기간 연장은 만료 후 재구독으로)
  if (gate.isSubscribedTo(viewer.address, creator.address)) {
    const expiresMs = Number(gate.subExpiry.get(`${tierId}:${viewer.address}`) || 0) || null
    return { digest: '', priceGeunhwa: 0, alreadySubscribed: true, expiresMs }
  }
  const idem = idempotencyKeyFor(req, viewer.did, 'subscribe', {
    key: `sub|${viewer.address}|${tierId}`,
    windowMs: 60_000,
  })
  const { digest } = await auditedMoney(
    'subscribe',
    viewer,
    { creator: creator.address, amountGeunhwa: price },
    () =>
      idempotent(idem.keys, idem.windowMs, () =>
        withPendingTx(idem.contextKey, 'subscribe', { tier: tierId, price }, onDigest =>
          execTx(viewer.address, buildSubscribe(tierId, price, viewer.address), 'Subscribed', { onDigest }),
        ),
      ),
  )
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
  // 이미 구매한 글의 재구매 요청은 새 트랜잭션 없이 종결 — 구매는 영구라 언제나 안전
  if (gate.purchased.has(`${postId}:${viewer.address}`)) {
    return { digest: '', priceGeunhwa: 0, postId, alreadyPurchased: true }
  }
  const idem = idempotencyKeyFor(req, viewer.did, 'purchasePost', {
    key: `ppv|${viewer.address}|${postId}`,
    windowMs: 60_000,
  })
  const { digest } = await auditedMoney(
    'purchasePost',
    viewer,
    { postId, amountGeunhwa: price },
    () =>
      idempotent(idem.keys, idem.windowMs, () =>
        withPendingTx(idem.contextKey, 'purchase', { paywall: pw.paywall, price }, onDigest =>
          execTx(viewer.address, buildPurchase(pw.paywall, price, viewer.address), 'PostPurchased', { onDigest }),
        ),
      ),
  )
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
  // 팁은 온체인에 자연 멱등성이 없다 — 동일 (발신, 수신, 글, 금액)의 20초 창
  // 중복만 흡수한다. 의도적 연속 팁은 20초 뒤부터 정상 통과. 클라이언트가
  // Idempotency-Key를 보내면 그쪽이 우선(창 10분).
  const idem = idempotencyKeyFor(req, viewer.did, 'tip', {
    key: `tip|${viewer.address}|${creator.address}|${postId ?? ''}|${amount}`,
    windowMs: 20_000,
  })
  const { digest } = await auditedMoney(
    'tip',
    viewer,
    { creator: creator.address, postId, amountGeunhwa: amount },
    () =>
      idempotent(idem.keys, idem.windowMs, () =>
        withPendingTx(idem.contextKey, 'tip', { to: creator.address, postId, amount }, onDigest =>
          execTx(viewer.address, buildTip(creator.address, postId, amount, viewer.address), 'TipSent', { onDigest }),
        ),
      ),
  )
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
  if (!(price >= 10_000_000 && price <= 100_000_000_000)) fail(400, 'Subscription price must be between 0.01 and 100 HANEUL')
  if (!(periodDays >= 1 && periodDays <= 365)) fail(400, 'Subscription period must be between 1 and 365 days')
  if (!['open', 'tease', 'lock'].includes(lockMode)) fail(400, 'lockMode must be one of open/tease/lock')
  const gate = await loadGateState()
  if (gate.tierByCreator.has(viewer.address)) fail(400, 'Already a creator (tier exists)')

  const periodMs = periodDays * 24 * 60 * 60 * 1000
  const name = viewer.handle.split('.')[0]
  // 잠금 모드는 티어와 같은 tx로 원자 확정 (tease=티저 노출, lock=전면 잠금)
  const { digest } = await execTx(
    viewer.address,
    buildBecomeCreator(price, periodMs, `ipfs://humming-tier-${name}`, lockMode, viewer.address),
    'TierCreated',
  )
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
  // 인덱서의 수익 원장(제네시스부터 전량) 기준 — 50건 초과분도 유실 없음
  const [posts, gate] = [await loadPosts(), loadGateState()]
  const authorOf = postId => posts.find(p => p.postId === String(postId))?.author.address
  const nameOf = addr => byAddress(addr)?.handle ?? `${addr.slice(0, 8)}…`
  const items = []
  for (const e of chainState.earnings) {
    const p = e.parsedJson
    const base = {
      grossGeunhwa: Number(p.amount),
      netGeunhwa: Number(p.amount) - Number(p.fee),
      atMs: e.timestampMs,
      tx: e.txDigest,
    }
    if (e.shortType === 'subscriptions::Subscribed') {
      if (gate.tierInfo.get(p.tier)?.creator !== viewer.address) continue
      items.push({ kind: 'subscription', from: nameOf(p.subscriber), ...base })
    } else if (e.shortType === 'tips::TipSent') {
      if (p.to !== viewer.address) continue
      items.push({ kind: 'tip', from: nameOf(p.from), postId: p.post_id ?? null, ...base })
    } else {
      if (authorOf(p.post_id) !== viewer.address) continue
      items.push({ kind: 'purchase', from: nameOf(p.buyer), postId: p.post_id, ...base })
    }
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

// --- app.humming.wallet: 지갑 패널 — "가입=지갑"을 UI에 드러내는 읽기 전용 뷰 ---
// 주소·잔고·최근 온체인 활동만 반환한다. 보내기(임의 이체 서명)는 의도적으로 없음:
// 수탁 파사드가 이체까지 서명하면 리스크 표면이 커지므로 비수탁 전환(패스키) 후에만.
xrpc('get', 'app.humming.wallet.getInfo', async req => {
  const viewer = requireAuthAcct(req)
  const [{ balance }, posts, gate] = await Promise.all([
    grpcClient.getBalance({ owner: viewer.address, coinType: HANEUL_TYPE }),
    loadPosts(),
    loadGateState(),
  ])
  const authorOf = postId => posts.find(p => p.postId === String(postId))?.author.address
  const nameOf = addr => byAddress(addr)?.handle ?? `${addr.slice(0, 8)}…`
  // 인덱서 수익 원장(제네시스부터 전량)에서 내가 당사자인 이체를 양방향으로 추림.
  // 나가는 돈은 gross(내가 낸 금액), 들어오는 돈은 net(수수료 차감 후 실수령)이 진실.
  const items = []
  for (const e of chainState.earnings) {
    const p = e.parsedJson
    const gross = Number(p.amount)
    const net = gross - Number(p.fee)
    const base = { atMs: e.timestampMs, tx: e.txDigest }
    if (e.shortType === 'subscriptions::Subscribed') {
      const creatorAddr = gate.tierInfo.get(p.tier)?.creator
      if (p.subscriber === viewer.address)
        items.push({ kind: 'subscription', direction: 'out', counterparty: nameOf(creatorAddr ?? ''), amountGeunhwa: gross, ...base })
      else if (creatorAddr === viewer.address)
        items.push({ kind: 'subscription', direction: 'in', counterparty: nameOf(p.subscriber), amountGeunhwa: net, ...base })
    } else if (e.shortType === 'tips::TipSent') {
      if (p.from === viewer.address)
        items.push({ kind: 'tip', direction: 'out', counterparty: nameOf(p.to), amountGeunhwa: gross, ...base })
      else if (p.to === viewer.address)
        items.push({ kind: 'tip', direction: 'in', counterparty: nameOf(p.from), amountGeunhwa: net, ...base })
    } else if (e.shortType === 'paid_posts::PostPurchased') {
      const author = authorOf(p.post_id)
      if (p.buyer === viewer.address)
        items.push({ kind: 'purchase', direction: 'out', counterparty: nameOf(author ?? ''), amountGeunhwa: gross, ...base })
      else if (author === viewer.address)
        items.push({ kind: 'purchase', direction: 'in', counterparty: nameOf(p.buyer), amountGeunhwa: net, ...base })
    }
  }
  items.sort((a, b) => b.atMs - a.atMs)
  return {
    address: viewer.address,
    handle: viewer.handle,
    balanceGeunhwa: Number(balance.balance),
    activity: items.slice(0, 20),
  }
})

// --- catch-all: log what the app asks for, fail soft ---
app.all('/xrpc/:nsid', (req, res) => {
  console.log(`🕳️  미구현 호출: ${req.method} ${req.params.nsid}`)
  res.status(501).json({ error: 'MethodNotImplemented', message: req.params.nsid })
})

// ---- 부팅: 키 로드 → 저널 리플레이+객체 재구성 → 서빙 시작 → 체크포인트 테일링 ----
loadKeys()
startBackups()
const imported = importFromCliKeystore([...ACCOUNTS.map(a => a.address), APP_WALLET])
if (imported) console.log(`🔑 CLI 키스토어에서 계정 키 ${imported}개 임포트`)
// 앱 지갑 키가 없으면 가입(이름 발급·스타터 가스)이 전부 실패한다 —
// 첫 유저의 500이 아니라 부팅이 알아채게 한다 (로컬넷은 키스토어 자동 임포트에 맡김)
if (!IS_LOCALNET && !keypairFor(APP_WALLET)) {
  console.error('❌ APP_WALLET 서명 키가 지갑 키 저장소에 없습니다 — 가입 처리가 불가능합니다.')
  console.error(`   ${APP_WALLET} 키를 wallet-keys.json에 넣거나 CLI 키스토어에서 임포트되게 하세요.`)
  process.exit(1)
}

const server = app.listen(PORT, () => {
  console.log(`🚀 Humming XRPC 파사드: http://localhost:${PORT} (public: ${PUBLIC_URL})`)
  console.log(`   체인: ${RPC_URL} / 패키지: ${PKG.slice(0, 10)}…`)
  if (!chainReady) console.log('   ⏳ 인덱스 복원 완료 전까지 XRPC는 503 (fail-closed)')
})

// ---- 우아한 종료: 새 연결 차단 → 인플라이트 드레인 → 상태 플러시 → 종료 ----
// 배포 재시작(systemd SIGTERM)이 진행 중 결제 요청을 자르지 않게 한다.
// 결제 pending·감사 로그는 동기 append라 별도 플러시가 필요 없다.
let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`   ${signal} 수신: 새 연결을 닫고 진행 중 요청을 드레인합니다`)
  stopTailing()
  await Promise.race([
    new Promise(resolve => server.close(resolve)),
    // 드레인 상한: 이 이상 붙잡는 연결은 포기한다 (keep-alive 소켓 등)
    new Promise(resolve => {
      const t = setTimeout(resolve, 10_000)
      t.unref?.()
    }),
  ])
  flushCursor()
  flushBackups()
  console.log('   상태 플러시 완료, 종료합니다')
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
// 복원이 전부 끝나야 서빙 개방(chainReady) — 부분 인덱스로 잠금을 판정하지 않는다.
// 실패 시 성공할 때까지 재시도: 체인이 내려간 동안 503은 의도된 동작(누출보다 다운타임).
// initIndex는 재호출 안전(리플레이·재구성 모두 멱등).
// 가입 크래시 창 화해: pending 가입 레코드를 체인과 대조한다.
// leaf가 우리 지갑으로 등록돼 있으면 계정을 입양하고(핸들·지갑 복구),
// 부재가 확인되면 지갑 키를 롤백한다. 조회 실패는 다음 부팅에 재시도.
async function reconcileSignups() {
  for (const rec of loadPendingSignups()) {
    if (byHandle(rec.handle)) {
      removePendingSignup(rec.handle)
      continue
    }
    let onchain
    try {
      onchain = await chainNameRecord(rec.handle, { strict: true })
    } catch (e) {
      console.warn(`   ⚠️ 가입 pending ${rec.handle} 체인 확인 실패 (다음 부팅에 재시도): ${e.message}`)
      continue
    }
    if (onchain && onchain.target === rec.address) {
      ACCOUNTS.push({
        handle: rec.handle,
        did: `did:web:${rec.handle}`,
        address: rec.address,
        displayName: rec.handle.slice(0, -'.hum.haneul'.length),
        description: 'New on Humming',
        passwordHash: rec.passwordHash,
        signup: true,
      })
      persistAccounts()
      console.log(`🐣 가입 복구: ${rec.handle} → 지갑 ${rec.address.slice(0, 10)}… (크래시로 누락된 계정 입양)`)
    } else if (Date.now() - rec.ts <= PENDING_HORIZON_MS) {
      // 크래시 직후의 빠른 재부팅: 등록 tx가 아직 체인에 실리는 중일 수 있다.
      // 지금 "부재"로 확정해 키를 지우면, 직후 tx가 실렸을 때 키 없는 계정과
      // 소진된 핸들이 남는다. 지평선이 지날 때까지 pending으로 유지한다.
      continue
    } else {
      // 부재 확인(또는 남의 주소로 등록): 체인 등록 전에 죽은 가입, 키 롤백
      removeWallet(rec.address)
    }
    removePendingSignup(rec.handle)
  }
}

for (;;) {
  try {
    // 함수로 넘긴다: 프루닝 복구(pruneRecover)가 부팅 이후 가입자 주소까지 반영
    await initIndex(() => ACCOUNTS.map(a => a.address))
    break
  } catch (e) {
    console.error('   ⚠️ 인덱스 복원 실패, 5초 후 재시도:', e.message)
    await new Promise(r => setTimeout(r, 5000))
  }
}
// 결제 pending·가입 pending의 부팅 화해. 실패해도 서빙은 연다 (레코드는 남아
// 재시도·다음 부팅이 처리하고, 미해결 결제 레코드는 요청 경로에서도 재판정된다)
try {
  const { kept } = await reconcilePendingTxs()
  if (kept) console.log(`   ⏳ 미해결 결제 pending ${kept}건 유지 (재시도 시 체인 대조)`)
  await reconcileSignups()
} catch (e) {
  console.warn(`   ⚠️ pending 화해 실패: ${e.message}`)
}
chainReady = true
console.log(`   ⛓️  인덱스 복원 완료, 서빙 개방: ${stats()}`)
startTailing()
