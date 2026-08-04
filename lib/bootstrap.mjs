// 온체인 객체에서 인덱스 상태 재구성 — 이벤트 이력이 프루닝돼도 현재 상태는
// 전부 객체로 살아 있다. Feed.posts 테이블(created_ms 포함), Tier.subs(구독
// 만료 원장), PostPaywall.purchases(구매 원장), PrefsRegistry가 각각 이벤트
// 스트림보다 원본에 가까운 진실. 유일하게 객체로 안 남는 것은 팁(순수
// 이벤트)으로, 운영 중엔 저널이 커버하고 과거분은 아카이브 리플레이로만 소급
// 가능하다.
//
// 티어 발견 경로: Tier는 shared라 소유자 조회가 안 되지만 TierCap이 크리에이터
// 지갑에 있다 — 파사드는 전 계정 주소를 아는 수탁 구조이므로 계정별
// getOwnedObjects(TierCap)로 전량 열거된다.
import { client } from './client.mjs'
import { PKG, FEED, PREFS_REGISTRY } from './config.mjs'

const fieldsOf = obj => obj?.data?.content?.fields ?? null
const tableId = t => t?.fields?.id?.id

async function allDynamicFields(parentId) {
  const out = []
  let cursor = null
  do {
    const page = await client.getDynamicFields({ parentId, cursor })
    out.push(...page.data)
    cursor = page.hasNextPage ? page.nextCursor : null
  } while (cursor)
  return out
}

// 동적 필드 래퍼(Field<K, V>) 내용물을 50개 단위로 일괄 조회
async function contentsOf(ids) {
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

async function tableEntries(parentId) {
  const refs = await allDynamicFields(parentId)
  return contentsOf(refs.map(r => r.objectId))
}

async function tierIdsOwnedBy(owner) {
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

// 현 체인 상태의 스냅샷 — 인덱서가 이벤트와 같은 어휘로 병합할 수 있는 형태
export async function readChainState(addresses) {
  const feed = fieldsOf(await client.getObject({ id: FEED, options: { showContent: true } }))
  if (!feed) throw new Error(`Feed 객체를 읽을 수 없습니다: ${FEED}`)

  const posts = (await tableEntries(tableId(feed.posts))).map(f => {
    const p = f.value.fields
    return {
      seq: String(p.seq),
      author: p.author,
      content_uri: p.content_uri,
      root: String(p.root),
      replied_to: p.replied_to ?? null,
      quoted: p.quoted ?? null,
      reposted: p.reposted ?? null,
      created_ms: Number(p.created_ms),
      deleted: !!p.deleted,
    }
  })

  // post_paywalls: Table<u64(post_id), ID(paywall)> → 페이월 객체 → 구매 원장
  const paywallRefs = (await tableEntries(tableId(feed.post_paywalls))).map(f => ({
    post_id: String(f.name),
    paywall: f.value,
  }))
  const paywallObjs = await contentsOf(paywallRefs.map(r => r.paywall))
  const paywalls = []
  for (let i = 0; i < paywallRefs.length; i++) {
    const f = paywallObjs[i]
    if (!f) continue
    paywalls.push({
      paywall: paywallRefs[i].paywall,
      post_id: String(f.post_id),
      price: String(f.price),
      purchases: (await tableEntries(tableId(f.purchases))).map(e => ({
        buyer: e.name,
        price: String(e.value),
      })),
    })
  }

  const tiers = []
  for (const addr of addresses) {
    for (const tierId of await tierIdsOwnedBy(addr)) {
      const f = fieldsOf(await client.getObject({ id: tierId, options: { showContent: true } }))
      if (!f) continue
      tiers.push({
        tier: tierId,
        creator: addr,
        price: String(f.price),
        period_ms: String(f.period_ms),
        subs: (await tableEntries(tableId(f.subs))).map(e => ({
          subscriber: e.name,
          expires_ms: Number(e.value),
        })),
      })
    }
  }

  const registry = fieldsOf(
    await client.getObject({ id: PREFS_REGISTRY, options: { showContent: true } }),
  )
  if (!registry) throw new Error(`PrefsRegistry 객체를 읽을 수 없습니다: ${PREFS_REGISTRY}`)
  const prefs = (await tableEntries(tableId(registry.prefs))).map(e => ({
    creator: e.name,
    profile_locked: !!e.value.fields.profile_locked,
    show_locked_previews: !!e.value.fields.show_locked_previews,
  }))

  return { posts, paywalls, tiers, prefs }
}
