// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// 체인 접근 계층 — SDK 클라이언트 단일 인스턴스, per-address 직렬화, PTB 빌더.
// 서명은 인프로세스 키쌍으로: 전역 active-address(CLI switch)가 사라져
// 서로 다른 지갑의 tx는 완전 병렬, 같은 지갑만 가스 코인 버전 충돌 방지용으로 직렬화.
import { Transaction } from '@mysten/sui/transactions'
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet'
import {
  FAUCET_URL, PKG, FEED, RULES, FEE_CONFIG, PREFS_REGISTRY, COIN_TYPE, COIN_IS_GAS,
  NS_SUB_PKG, NS_OBJ, HUM_PARENT_NFT, APP_WALLET, SPONSOR_GAS, GAS_COIN_TYPE,
} from './config.mjs'
import { grpcClient } from './client.mjs'
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
// 자기 tx 이벤트를 인덱서에 즉시 주입 (테일링 랙 없이 다음 읽기에 바로 반영)
export async function execTx(address, build, expectEvent = null, { onDigest } = {}) {
  const signer = keypairFor(address)
  if (!signer) throw new Error(`No signing key for ${address}`)
  // 스폰서드 가스: 서명자가 앱 지갑이 아니면 가스는 앱 지갑이 낸다 (SPONSOR_GAS 네트워크).
  // 직렬화 큐 키는 "가스 코인의 소유자"다 — 스폰서드 tx는 전부 앱 지갑 가스 코인을
  // 소비하므로 발신자가 달라도 앱 지갑 큐로 직렬화해야 equivocation이 없다.
  const sponsor = SPONSOR_GAS && APP_WALLET && address !== APP_WALLET ? keypairFor(APP_WALLET) : null
  return withWallet(sponsor ? APP_WALLET : address, async () => {
    const tx = new Transaction()
    tx.setGasBudget(GAS_BUDGET)
    await build(tx)
    if (sponsor) {
      tx.setSender(address)
      tx.setGasOwner(APP_WALLET)
    }
    if (onDigest) {
      // 결제 tx의 pending 기록용: 다이제스트를 실행 전에 확정해 넘긴다.
      // getDigest가 입력·가스를 전부 해석(build)하므로, 이어지는 실행은 같은
      // 바이트를 재사용해 다이제스트가 달라질 수 없다 (isFullyResolved 상태).
      tx.setSenderIfNotSet(address)
      onDigest(await tx.getDigest({ client: grpcClient }))
    }
    // gRPC 실행 — 트랜잭션 빌드의 숨은 읽기(입력 객체 해석·가스 코인 선택·가스가격)까지
    // 클라이언트가 gRPC로 수행한다. 실행 응답은 이벤트 json을 렌더링해 주므로
    // 동기 주입이 스트림을 기다리지 않고 그대로 유지된다.
    // 스폰서드 경로는 바이트를 직접 빌드해 발신자·스폰서 이중 서명으로 제출한다.
    let res
    if (sponsor) {
      const bytes = await tx.build({ client: grpcClient })
      const senderSig = (await signer.signTransaction(bytes)).signature
      const sponsorSig = (await sponsor.signTransaction(bytes)).signature
      res = await grpcClient.executeTransaction({
        transaction: bytes,
        signatures: [senderSig, sponsorSig],
        include: { events: true },
      })
    } else {
      res = await grpcClient.signAndExecuteTransaction({
        transaction: tx,
        signer,
        include: { events: true },
      })
    }
    const r = res.Transaction ?? res.FailedTransaction
    if (res.$kind !== 'Transaction')
      throw new Error(`Transaction failed: ${r.status?.error?.message ?? 'unknown'} (${r.digest})`)
    // 인덱서·저널·소비자(post_id 추출 등)가 쓰는 어휘로 변환 — 테일링 이벤트와 동일 형태.
    // 실행 응답에는 체크포인트 타임스탬프가 아직 없으므로 실행 시각으로 근사한다
    // (같은 이벤트를 테일링이 다시 만나면 dedupe가 걸러 저널의 첫 관측이 승리).
    const now = Date.now()
    const events = (r.events ?? []).map((ev, i) => ({
      type: ev.eventType,
      parsedJson: ev.json,
      id: { txDigest: r.digest, eventSeq: String(i) },
      timestampMs: now,
    }))
    if (expectEvent && !events.some(e => e.type.endsWith(`::${expectEvent}`)))
      throw new Error(`Event ${expectEvent} not found (tx: ${r.digest})`)
    ingestEvents(events, now)
    // 노드가 새 오브젝트 버전을 반영한 뒤에 큐를 놓는다 — 같은 지갑의 다음 tx가
    // 낡은 가스 코인 버전을 집어 equivocation으로 죽는 것을 방지 (부트스트랩에서 실측)
    await grpcClient.waitForTransaction({ digest: r.digest })
    return { digest: r.digest, events }
  })
}

export async function faucet(recipient) {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient })
}

// 가입 스타터 가스 — faucet이 없는 체인에서 APP_WALLET 가스에서 소액을 떼어 새 지갑에 지급.
// 가입 PTB(buildNewLeaf)와 한 tx로 묶어 "이름만 등록된 무가스 지갑" 부분 실패 창을 없앤다
export const buildStarterGas = (recipient, amount) => tx => {
  const [coin] = tx.splitCoins(tx.gas, [amount])
  tx.transferObjects([coin], tx.pure.address(recipient))
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
      typeArguments: [COIN_TYPE],
      arguments: [tx.object(FEED), pid, tx.pure.u64(paywallGeunhwa)],
    })
  }
}

// 글 삭제 — 체인이 작성자만 허용(ENotAuthor), content_uri를 비우고 deleted를 세운다.
// 페이월이 걸린 글은 이후 purchase가 EPostNotFound로 막힌다 (구매 이력은 남는다)
export const buildDeletePost = postId => tx => {
  tx.moveCall({
    target: `${PKG}::feed::delete_post`,
    arguments: [tx.object(FEED), tx.pure.u64(postId)],
  })
}

// 결제 공통 골격: 대금 분리 → 호출 → 잔액(&mut Coin) 반환.
// 결제 통화가 가스 코인이면 tx.gas에서 분리(입력 해석 추가 비용 0). 아니면(USDC 등)
// 지불자(viewer)의 코인 객체를 조회해 필요액까지 병합 후 분리한다 — 지불자와
// 서명자가 같은 수탁 구조라 소유 코인을 tx 입력으로 그대로 쓸 수 있다.
const withPayment = async (tx, amount, viewer, call) => {
  let source = tx.gas
  if (!COIN_IS_GAS) {
    const { objects } = await grpcClient.listCoins({ owner: viewer, coinType: COIN_TYPE })
    const picked = []
    let sum = 0n
    for (const o of objects) {
      picked.push(o.objectId)
      sum += BigInt(o.balance ?? 0)
      if (sum >= BigInt(amount)) break
    }
    if (sum < BigInt(amount)) throw new Error(`Insufficient ${COIN_TYPE} balance: ${sum} < ${amount}`)
    source = tx.object(picked[0])
    if (picked.length > 1) tx.mergeCoins(source, picked.slice(1).map(id => tx.object(id)))
  }
  const [pay] = tx.splitCoins(source, [amount])
  call(pay)
  tx.transferObjects([pay], tx.pure.address(viewer))
}

// 구독: expected_price로 프론트러닝 방어 (가격 변경이 먼저 오르면 abort)
export const buildSubscribe = (tierId, price, viewer) => async tx => {
  await withPayment(tx, price, viewer, pay => {
    tx.moveCall({
      target: `${PKG}::subscriptions::subscribe`,
      typeArguments: [COIN_TYPE],
      arguments: [
        tx.object(tierId), tx.object(FEE_CONFIG), tx.pure.address(viewer),
        tx.pure.u64(price), pay, tx.object(CLOCK),
      ],
    })
  })
}

// 단건 구매(PPV)
export const buildPurchase = (paywallId, price, viewer) => async tx => {
  await withPayment(tx, price, viewer, pay => {
    tx.moveCall({
      target: `${PKG}::paid_posts::purchase`,
      typeArguments: [COIN_TYPE],
      arguments: [
        tx.object(paywallId), tx.object(FEE_CONFIG), tx.object(FEED),
        tx.pure.u64(price), pay,
      ],
    })
  })
}

// 팁 — 글 귀속이면 수취인은 체인이 글 작성자로 강제
export const buildTip = (creatorAddr, postId, amount, viewer) => async tx => {
  await withPayment(tx, amount, viewer, pay => {
    if (postId != null) {
      tx.moveCall({
        target: `${PKG}::tips::tip_post`,
        typeArguments: [COIN_TYPE],
        arguments: [
          tx.object(FEE_CONFIG), tx.object(FEED),
          tx.pure.u64(postId), tx.pure.u64(amount), pay,
        ],
      })
    } else {
      tx.moveCall({
        target: `${PKG}::tips::tip`,
        typeArguments: [COIN_TYPE],
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
    typeArguments: [COIN_TYPE],
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

// 스폰서 가스 잔액(최소 단위). 앱 지갑 하나가 전 유저 tx의 가스를 대납하므로 이 값이
// 바닥나면 서비스 전체가 멈춘다 — 운영 경보의 기준값. 첫 페이지(수백 개)만 합산해도
// 경보 용도로는 충분하다 (가스 코인은 병합되어 보통 몇 개 안 된다).
export async function gasBalance(owner = APP_WALLET) {
  const { objects } = await grpcClient.listCoins({ owner, coinType: GAS_COIN_TYPE })
  return objects.reduce((sum, o) => sum + BigInt(o.balance ?? 0), 0n)
}
