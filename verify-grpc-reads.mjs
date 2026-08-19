// gRPC 읽기 경로 등가 검증 — 객체 재구성(readChainState)·체인ID·잔고·NS 이름
// 조회를 두 전송으로 수행해 산출물이 같은지 비교한다. 읽기 전용.
// JSON-RPC 레그는 구 구현의 사본이다 — 업스트림이 JSON-RPC를 실제로 제거한
// 노드에서는 이 비교는 의미를 잃는다(기록용).
// 사용: HUMMING_NETWORK=mainnet node verify-grpc-reads.mjs accounts.mainnet.json [handle]
import fs from 'node:fs'
import { HaneulJsonRpcClient } from '@haneullabs/haneul/jsonRpc'
import { bcs } from '@haneullabs/haneul/bcs'
import { readChainState } from './lib/bootstrap.mjs'
import { grpcClient } from './lib/client.mjs'
import { chainIdentifier, getObjectJson, listAllDynamicFields } from './lib/grpc.mjs'
import {
  NETWORK, RPC_URL, FEED, PREFS_REGISTRY, PKG, NS_OBJ, NS_PKG, HANEUL_TYPE,
  DENY_BLOCKED_TABLE, DENY_RESERVED_TABLE,
} from './lib/config.mjs'

const client = new HaneulJsonRpcClient({ network: 'localnet', url: RPC_URL })
const ok = (label, cond, detail = '') => {
  if (!cond) throw new Error(`FAIL: ${label} ${detail}`)
  console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`)
}
const canon = v =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]]))
      : x,
  )

const addresses = JSON.parse(fs.readFileSync(process.argv[2] ?? './accounts.mainnet.json', 'utf8'))
  .map(a => a.address)
const handle = process.argv[3] ?? 'bomi.hum.haneul'

// ---- 레거시 레그: 구 bootstrap.mjs의 JSON-RPC 구현 사본 ----
const fieldsOf = obj => obj?.data?.content?.fields ?? null
const legacyTableId = t => t?.fields?.id?.id
async function legacyAllDynamicFields(parentId) {
  const out = []
  let cursor = null
  do {
    const page = await client.getDynamicFields({ parentId, cursor })
    out.push(...page.data)
    cursor = page.hasNextPage ? page.nextCursor : null
  } while (cursor)
  return out
}
async function legacyContentsOf(ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 50) {
    const page = await client.multiGetObjects({
      ids: ids.slice(i, i + 50),
      options: { showContent: true },
    })
    out.push(...page.map(fieldsOf))
  }
  return out.filter(Boolean)
}
async function legacyTableEntries(parentId) {
  return legacyContentsOf((await legacyAllDynamicFields(parentId)).map(r => r.objectId))
}
async function legacyTierIdsOwnedBy(owner) {
  const ids = []
  let cursor = null
  do {
    const page = await client.getOwnedObjects({
      owner,
      filter: { StructType: `${PKG}::subscriptions::TierCap` },
      options: { showContent: true },
      cursor,
    })
    for (const o of page.data) {
      const tier = fieldsOf(o)?.tier
      if (tier) ids.push(tier)
    }
    cursor = page.hasNextPage ? page.nextCursor : null
  } while (cursor)
  return ids
}
async function legacyReadChainState() {
  const feed = fieldsOf(await client.getObject({ id: FEED, options: { showContent: true } }))
  const posts = (await legacyTableEntries(legacyTableId(feed.posts))).map(f => {
    const p = f.value.fields
    return {
      seq: String(p.seq), author: p.author, content_uri: p.content_uri, root: String(p.root),
      replied_to: p.replied_to ?? null, quoted: p.quoted ?? null, reposted: p.reposted ?? null,
      created_ms: Number(p.created_ms), deleted: !!p.deleted,
    }
  })
  const paywallRefs = (await legacyTableEntries(legacyTableId(feed.post_paywalls))).map(f => ({
    post_id: String(f.name), paywall: f.value,
  }))
  const paywallObjs = await legacyContentsOf(paywallRefs.map(r => r.paywall))
  const paywalls = []
  for (let i = 0; i < paywallRefs.length; i++) {
    const f = paywallObjs[i]
    if (!f) continue
    paywalls.push({
      paywall: paywallRefs[i].paywall, post_id: String(f.post_id), price: String(f.price),
      purchases: (await legacyTableEntries(legacyTableId(f.purchases))).map(e => ({
        buyer: e.name, price: String(e.value),
      })),
    })
  }
  const tiers = []
  for (const addr of addresses) {
    for (const tierId of await legacyTierIdsOwnedBy(addr)) {
      const f = fieldsOf(await client.getObject({ id: tierId, options: { showContent: true } }))
      if (!f) continue
      tiers.push({
        tier: tierId, creator: addr, price: String(f.price), period_ms: String(f.period_ms),
        subs: (await legacyTableEntries(legacyTableId(f.subs))).map(e => ({
          subscriber: e.name, expires_ms: Number(e.value),
        })),
      })
    }
  }
  const registry = fieldsOf(
    await client.getObject({ id: PREFS_REGISTRY, options: { showContent: true } }),
  )
  const prefs = (await legacyTableEntries(legacyTableId(registry.prefs))).map(e => ({
    creator: e.name,
    profile_locked: !!e.value.fields.profile_locked,
    show_locked_previews: !!e.value.fields.show_locked_previews,
  }))
  return { posts, paywalls, tiers, prefs }
}

// ---- ① 객체 재구성 등가 ----
const [viaGrpc, viaJson] = [await readChainState(addresses), await legacyReadChainState()]
// 순서는 전송·페이지네이션에 따라 다를 수 있으므로 정렬 후 비교
const sortState = s => ({
  posts: [...s.posts].sort((a, b) => Number(a.seq) - Number(b.seq)),
  paywalls: [...s.paywalls]
    .sort((a, b) => Number(a.post_id) - Number(b.post_id))
    .map(pw => ({ ...pw, purchases: [...pw.purchases].sort((a, b) => a.buyer.localeCompare(b.buyer)) })),
  tiers: [...s.tiers]
    .sort((a, b) => a.tier.localeCompare(b.tier))
    .map(t => ({ ...t, subs: [...t.subs].sort((a, b) => a.subscriber.localeCompare(b.subscriber)) })),
  prefs: [...s.prefs].sort((a, b) => a.creator.localeCompare(b.creator)),
})
ok('readChainState 등가', canon(sortState(viaGrpc)) === canon(sortState(viaJson)),
  `posts=${viaGrpc.posts.length} paywalls=${viaGrpc.paywalls.length} tiers=${viaGrpc.tiers.length} prefs=${viaGrpc.prefs.length}`)

// ---- ② 체인 식별자 ----
const [cidG, cidJ] = [await chainIdentifier(), await client.getChainIdentifier()]
ok('chainIdentifier 등가', cidG === cidJ, cidG)

// ---- ③ 잔고 ----
if (addresses[0]) {
  const g = (await grpcClient.getBalance({ owner: addresses[0], coinType: HANEUL_TYPE })).balance.balance
  const j = (await client.getBalance({ owner: addresses[0], coinType: HANEUL_TYPE })).totalBalance
  ok('getBalance 등가', String(g) === String(j), `${addresses[0].slice(0, 10)}… = ${g}`)
}

// ---- ④ NS 이름 조회 + denylist (메인넷 배포값이 있는 네트워크에서만) ----
if (NETWORK === 'mainnet') {
  const dfs = await listAllDynamicFields(NS_OBJ)
  const reg = dfs.find(d => (d.name?.type || '').includes('::registry::Registry>'))
  const deepFind = (obj, key) => {
    if (!obj || typeof obj !== 'object') return undefined
    if (obj[key] !== undefined) return obj[key]
    for (const v of Object.values(obj)) {
      const found = deepFind(v, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  const table = deepFind(await getObjectJson(reg.fieldId), 'registry').id
  const labels = handle.toLowerCase().split('.').reverse()
  const DomainBcs = bcs.struct('Domain', { labels: bcs.vector(bcs.string()) })
  let fieldId = null
  try {
    ;({ dynamicField: { fieldId } } = await grpcClient.getDynamicField({
      parentId: table,
      name: { type: `${NS_PKG}::domain::Domain`, bcs: DomainBcs.serialize({ labels }).toBytes() },
    }))
  } catch {}
  const recG = fieldId ? deepFind(await getObjectJson(fieldId), 'target_address') : null
  const recJ = deepFind(
    await client.getDynamicFieldObject({
      parentId: table,
      name: { type: `${NS_PKG}::domain::Domain`, value: { labels } },
    }),
    'target_address',
  )
  ok('NS 핸들 해석 등가', String(recG) === String(recJ), `${handle} → ${String(recG).slice(0, 12)}…`)

  const denied = async label => {
    const name = bcs.string().serialize(label).toBytes()
    for (const t of [DENY_BLOCKED_TABLE, DENY_RESERVED_TABLE]) {
      try {
        await grpcClient.getDynamicField({ parentId: t, name: { type: '0x1::string::String', bcs: name } })
        return true
      } catch {}
    }
    return false
  }
  ok('denylist 예약어 검출', (await denied('admin')) === true, 'admin=거부')
  ok('denylist 일반어 통과', (await denied('zq9x7wk2m')) === false, 'zq9x7wk2m=허용')
}

console.log('\n🎉 전 항목 통과')
