// 체인 접근 계층 — SDK 클라이언트 단일 인스턴스, per-address 직렬화, PTB 빌더.
// 서명은 인프로세스 키쌍으로: 전역 active-address(CLI switch)가 사라져
// 서로 다른 지갑의 tx는 완전 병렬, 같은 지갑만 가스 코인 버전 충돌 방지용으로 직렬화.
import { Transaction } from '@haneullabs/haneul/transactions'
import { requestHaneulFromFaucetV2 } from '@haneullabs/haneul/faucet'
import {
  FAUCET_URL, PKG, FEED, RULES, FEE_CONFIG, PREFS_REGISTRY, HANEUL_TYPE,
  NS_SUB_PKG, NS_OBJ, HUM_PARENT_NFT,
} from './config.mjs'
import { client } from './client.mjs'
import { keypairFor } from './keys.mjs'
import { ingestEvents } from './indexer.mjs'

const CLOCK = '0x6'
const GAS_BUDGET = 50_000_000

// 같은 서명자의 tx만 직렬화 (가스 코인 equivocation 방지) — 지갑이 다르면 병렬
const queues = new Map()
function withWallet(address, fn) {
  const prev = queues.get(address) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  queues.set(address, tail)
  // 큐가 빈 주소는 엔트리 제거 — tx를 보낸 주소마다 맵이 무한 성장하지 않게
  tail.then(() => {
    if (queues.get(address) === tail) queues.delete(address)
  })
  return run
}

// 공통 실행기: 빌드 → 서명·실행 → effects 성공 확인 → 기대 이벤트 확인 →
// 자기 tx 이벤트를 인덱서에 즉시 주입 (폴링 랙 없이 다음 읽기에 바로 반영)
export async function execTx(address, build, expectEvent = null) {
  const signer = keypairFor(address)
  if (!signer) throw new Error(`서명 키 없음: ${address}`)
  return withWallet(address, async () => {
    const tx = new Transaction()
    tx.setGasBudget(GAS_BUDGET)
    build(tx)
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: { showEffects: true, showEvents: true },
    })
    if (res.effects?.status?.status !== 'success')
      throw new Error(`tx 실패: ${res.effects?.status?.error ?? 'unknown'} (${res.digest})`)
    const events = res.events ?? []
    if (expectEvent && !events.some(e => e.type.endsWith(`::${expectEvent}`)))
      throw new Error(`${expectEvent} 이벤트 미발견 (tx: ${res.digest})`)
    ingestEvents(events, Number(res.timestampMs ?? Date.now()))
    // 노드가 새 오브젝트 버전을 반영한 뒤에 큐를 놓는다 — 같은 지갑의 다음 tx가
    // 낡은 가스 코인 버전을 집어 equivocation으로 죽는 것을 방지 (부트스트랩에서 실측)
    await client.waitForTransaction({ digest: res.digest })
    return { digest: res.digest, events }
  })
}

export async function faucet(recipient) {
  await requestHaneulFromFaucetV2({ host: FAUCET_URL, recipient })
}

// ---- PTB 빌더 (기존 CLI ptb 문자열과 1:1) ----

// 가입: hum.haneul 부모 NFT 소유자(앱 지갑)가 leaf 서브네임 발급
export const buildNewLeaf = (handle, target) => tx => {
  tx.moveCall({
    target: `${NS_SUB_PKG}::subdomains::new_leaf`,
    arguments: [
      tx.object(NS_OBJ), tx.object(HUM_PARENT_NFT), tx.object(CLOCK),
      tx.pure.string(handle), tx.pure.address(target),
    ],
  })
}

// 글 작성(+선택적 페이월) — 글과 가격이 한 tx로 원자 확정
export const buildCreatePost = (content, parentId, paywallGeunhwa) => tx => {
  const [ticket, req] = tx.moveCall({
    target: `${PKG}::feed::request_create_post`,
    arguments: [
      tx.object(FEED), tx.pure.string(content),
      tx.pure.option('u64', parentId ?? null),
      tx.pure.option('u64', null), tx.pure.option('u64', null),
    ],
  })
  const pid = tx.moveCall({
    target: `${PKG}::feed::execute_create_post`,
    arguments: [tx.object(FEED), tx.object(RULES), ticket, req, tx.object(CLOCK)],
  })
  if (paywallGeunhwa) {
    tx.moveCall({
      target: `${PKG}::paid_posts::create`,
      typeArguments: [HANEUL_TYPE],
      arguments: [tx.object(FEED), pid, tx.pure.u64(paywallGeunhwa)],
    })
  }
}

// 결제 공통 골격: 가스에서 대금 분리 → 호출 → 잔액(&mut Coin) 반환
const withPayment = (tx, amount, viewer, call) => {
  const [pay] = tx.splitCoins(tx.gas, [amount])
  call(pay)
  tx.transferObjects([pay], tx.pure.address(viewer))
}

// 구독: expected_price로 프론트러닝 방어 (가격 변경이 먼저 오르면 abort)
export const buildSubscribe = (tierId, price, viewer) => tx => {
  withPayment(tx, price, viewer, pay => {
    tx.moveCall({
      target: `${PKG}::subscriptions::subscribe`,
      typeArguments: [HANEUL_TYPE],
      arguments: [
        tx.object(tierId), tx.object(FEE_CONFIG), tx.pure.address(viewer),
        tx.pure.u64(price), pay, tx.object(CLOCK),
      ],
    })
  })
}

// 단건 구매(PPV)
export const buildPurchase = (paywallId, price, viewer) => tx => {
  withPayment(tx, price, viewer, pay => {
    tx.moveCall({
      target: `${PKG}::paid_posts::purchase`,
      typeArguments: [HANEUL_TYPE],
      arguments: [
        tx.object(paywallId), tx.object(FEE_CONFIG), tx.object(FEED),
        tx.pure.u64(price), pay,
      ],
    })
  })
}

// 팁 — 글 귀속이면 수취인은 체인이 글 작성자로 강제
export const buildTip = (creatorAddr, postId, amount, viewer) => tx => {
  withPayment(tx, amount, viewer, pay => {
    if (postId != null) {
      tx.moveCall({
        target: `${PKG}::tips::tip_post`,
        typeArguments: [HANEUL_TYPE],
        arguments: [
          tx.object(FEE_CONFIG), tx.object(FEED),
          tx.pure.u64(postId), tx.pure.u64(amount), pay,
        ],
      })
    } else {
      tx.moveCall({
        target: `${PKG}::tips::tip`,
        typeArguments: [HANEUL_TYPE],
        arguments: [
          tx.object(FEE_CONFIG), tx.pure.address(creatorAddr),
          tx.pure.u64(amount), pay,
        ],
      })
    }
  })
}

// 크리에이터 전환: 티어 생성(+선택적 프로필 잠금)을 한 tx로 원자 확정
export const buildBecomeCreator = (price, periodMs, metadataUri, lockMode, viewer) => tx => {
  const tierCap = tx.moveCall({
    target: `${PKG}::subscriptions::create`,
    typeArguments: [HANEUL_TYPE],
    arguments: [tx.pure.u64(price), tx.pure.u64(periodMs), tx.pure.string(metadataUri)],
  })
  tx.transferObjects([tierCap], tx.pure.address(viewer))
  if (lockMode !== 'open') {
    tx.moveCall({
      target: `${PKG}::creator_prefs::set_prefs`,
      arguments: [
        tx.object(PREFS_REGISTRY), tx.pure.bool(true), tx.pure.bool(lockMode === 'tease'),
      ],
    })
  }
}
