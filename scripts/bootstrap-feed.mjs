// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// 배포 부트스트랩: 패키지 publish 뒤 한 번, APP_WALLET 서명으로 공유 Feed와 그 RuleSet을
// 만든다. CLI는 feed::create의 반환 튜플(cap 2개)을 소비하지 못해 SDK 경유가 필요하다.
//
// 네트워크·패키지·앱 지갑·키 저장소(암호화 포함)는 전부 lib/에서 온다 — 이 파일에는
// 체인별 상수가 없어 네트워크 맵의 어느 항목에서도 그대로 돈다:
//   HUMMING_NETWORK=<network> [HUMMING_KEYS_PASSPHRASE=..] node scripts/bootstrap-feed.mjs
// 출력된 FEED/RULES를 lib/config.mjs의 해당 네트워크 블록에 기입하면 파사드를 띄울 수 있다.
import { NETWORK, PKG, APP_WALLET, FEED } from '../lib/config.mjs'
import { loadKeys, keypairFor } from '../lib/keys.mjs'
import { execTx } from '../lib/chain.mjs'
import { getObjectJson } from '../lib/grpc.mjs'

const die = msg => {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

if (!PKG) die(`lib/config.mjs의 ${NETWORK} 블록에 PKG가 없습니다 — 패키지를 먼저 publish하고 기입하세요.`)
if (!APP_WALLET) die(`lib/config.mjs의 ${NETWORK} 블록에 APP_WALLET이 없습니다.`)
// 이미 Feed가 있는 네트워크에 두 번째 Feed를 만들면 두 원장이 갈라진다 — 의도적 재생성은
// config에서 FEED를 지운 뒤에만 가능하게 한다.
if (FEED) die(`${NETWORK} 블록에 이미 FEED(${FEED})가 있습니다. 재생성이 목적이면 먼저 지우세요.`)

loadKeys()
if (!keypairFor(APP_WALLET))
  die(`APP_WALLET ${APP_WALLET} 의 서명 키가 이 네트워크의 키 저장소에 없습니다.`)

console.log(`⛓️  ${NETWORK}: ${PKG.slice(0, 10)}…::feed::create (서명 ${APP_WALLET.slice(0, 10)}…)`)
const { digest, events } = await execTx(
  APP_WALLET,
  tx => {
    const caps = tx.moveCall({
      target: `${PKG}::feed::create`,
      arguments: [tx.pure.string('ipfs://humming-feed')],
    })
    // FeedAdminCap·RuleSetCap — 운영 키(앱 지갑)가 보관한다
    tx.transferObjects([caps[0], caps[1]], tx.pure.address(APP_WALLET))
  },
  'FeedCreated',
)
const feed = events.find(e => e.type.endsWith('::feed::FeedCreated')).parsedJson.feed
// RuleSet id는 Feed 객체의 feed_rules 필드가 원본 (FeedCreated 이벤트에는 실리지 않는다)
const feedObj = await getObjectJson(feed)
if (!feedObj?.feed_rules) die(`Feed ${feed} 를 다시 읽지 못했습니다 (tx ${digest})`)

console.log(`✅ tx ${digest}`)
console.log(`\nlib/config.mjs 의 ${NETWORK} 블록에 기입:`)
console.log(`  FEED: '${feed}',`)
console.log(`  RULES: '${feedObj.feed_rules}',`)
