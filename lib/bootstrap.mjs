// 온체인 객체에서 인덱스 상태 재구성 — 이벤트 이력이 프루닝돼도 현재 상태는
// 전부 객체로 살아 있다. Feed.posts 테이블(created_ms 포함), Tier.subs(구독
// 만료 원장), PostPaywall.purchases(구매 원장), PrefsRegistry가 각각 이벤트
// 스트림보다 원본에 가까운 진실. 유일하게 객체로 안 남는 것은 팁(순수
// 이벤트)으로, 운영 중엔 저널이 커버하고 과거분은 아카이브 리플레이로만 소급
// 가능하다.
//
// 읽기는 전부 gRPC(json read_mask)다 — 렌더링이 JSON-RPC content.fields와 달리
// 래퍼 없는 평면 구조라는 점만 다르고(Table → {id, size}, struct → 평면 객체),
// 값 규약(u64→문자열, Option→null)은 동일하다. 메인넷 실데이터로 구 구현과
// 산출물 등가를 확인했다 (verify-grpc-reads.mjs).
//
// 티어 발견 경로: Tier는 shared라 소유자 조회가 안 되지만 TierCap이 크리에이터
// 지갑에 있다 — 파사드는 전 계정 주소를 아는 수탁 구조이므로 계정별
// ListOwnedObjects(TierCap)로 전량 열거된다.
import { PKG, FEED, PREFS_REGISTRY, FEE_CONFIG } from './config.mjs'
import { getObjectJson, getObjectsJson, listAllDynamicFields, listOwnedJson } from './grpc.mjs'

const tableId = t => t?.id

// 테이블의 동적 필드 래퍼(Field<K, V>) 내용물 전량 — {id, name, value} 평면 json
async function tableEntries(parentId) {
  const refs = await listAllDynamicFields(parentId)
  return (await getObjectsJson(refs.map(r => r.fieldId))).filter(Boolean)
}

async function tierIdsOwnedBy(owner) {
  const caps = await listOwnedJson(owner, `${PKG}::subscriptions::TierCap`)
  return caps.map(c => c.json?.tier).filter(Boolean)
}

// 현 체인 상태의 스냅샷 — 인덱서가 이벤트와 같은 어휘로 병합할 수 있는 형태
export async function readChainState(addresses) {
  const feed = await getObjectJson(FEED)
  if (!feed) throw new Error(`Feed 객체를 읽을 수 없습니다: ${FEED}`)

  const posts = (await tableEntries(tableId(feed.posts))).map(f => {
    const p = f.value
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
  const paywallObjs = await getObjectsJson(paywallRefs.map(r => r.paywall))
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
      const f = await getObjectJson(tierId)
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

  const registry = await getObjectJson(PREFS_REGISTRY)
  if (!registry) throw new Error(`PrefsRegistry 객체를 읽을 수 없습니다: ${PREFS_REGISTRY}`)
  const prefs = (await tableEntries(tableId(registry.prefs))).map(e => ({
    creator: e.name,
    profile_locked: !!e.value.profile_locked,
    show_locked_previews: !!e.value.show_locked_previews,
  }))

  // 플랫폼 수수료 — 결제 경로가 전부 이 객체를 읽으므로 없으면 부팅 자체가 무의미하다
  const feeConfig = await getObjectJson(FEE_CONFIG)
  if (!feeConfig) throw new Error(`FeeConfig 객체를 읽을 수 없습니다: ${FEE_CONFIG}`)
  const feeBps = Number(feeConfig.fee_bps)

  return { posts, paywalls, tiers, prefs, feeBps }
}
