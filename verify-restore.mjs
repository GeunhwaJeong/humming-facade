// 복원 dry-run — readChainState가 메인넷 실물 객체를 올바르게 파싱하는지 검증.
// 읽기 전용: 어떤 tx도 보내지 않고 저널·커서 파일도 건드리지 않는다.
// 사용: HUMMING_NETWORK=mainnet node verify-restore.mjs <accounts.json>
import fs from 'node:fs'
import { readChainState } from './lib/bootstrap.mjs'
import { client } from './lib/client.mjs'

const accountsFile = process.argv[2]
if (!accountsFile) {
  console.error('사용법: node verify-restore.mjs <accounts.json>')
  process.exit(1)
}
const addresses = JSON.parse(fs.readFileSync(accountsFile, 'utf8')).map(a => a.address)
console.log(`계정 ${addresses.length}개로 재구성 시작...`)

const t0 = Date.now()
const cs = await readChainState(addresses)
console.log(`재구성 완료 (${Date.now() - t0}ms)`)
console.log(`  posts: ${cs.posts.length} (deleted 포함), live: ${cs.posts.filter(p => !p.deleted).length}`)
for (const p of cs.posts.slice(0, 5))
  console.log(`    #${p.seq} by ${p.author.slice(0, 10)}… root=${p.root} replied_to=${JSON.stringify(p.replied_to)} created=${new Date(p.created_ms).toISOString()} uri=${String(p.content_uri).slice(0, 60)}`)
console.log(`  paywalls: ${cs.paywalls.length}`)
for (const pw of cs.paywalls)
  console.log(`    post ${pw.post_id}: ${Number(pw.price) / 1e9} HANEUL, purchases=${pw.purchases.length}`, pw.purchases.map(b => b.buyer.slice(0, 10)))
console.log(`  tiers: ${cs.tiers.length}`)
for (const t of cs.tiers)
  console.log(`    ${t.tier.slice(0, 10)}… creator=${t.creator.slice(0, 10)}… ${Number(t.price) / 1e9} HANEUL/${Number(t.period_ms) / 86400000}일 subs=${t.subs.length}`, t.subs.map(s => `${s.subscriber.slice(0, 10)}→${new Date(s.expires_ms).toISOString().slice(0, 10)}`))
console.log(`  prefs: ${cs.prefs.length}`)
for (const pr of cs.prefs)
  console.log(`    ${pr.creator.slice(0, 10)}… locked=${pr.profile_locked} previews=${pr.show_locked_previews}`)

// 체크포인트 테일링 스모크 — 최신 체크포인트 페이지를 실제로 읽어본다
const tip = Number(await client.getLatestCheckpointSequenceNumber())
const page = await client.getCheckpoints({ cursor: String(tip - 5), limit: 5, descendingOrder: false })
const digests = page.data.flatMap(cp => cp.transactions)
const txs = await client.multiGetTransactionBlocks({ digests: digests.slice(0, 50), options: { showEvents: true } })
console.log(`테일링 스모크: tip=${tip}, page=${page.data.length}ckpt, txs=${txs.length}, events=${txs.reduce((n, t) => n + (t?.events?.length ?? 0), 0)}`)
