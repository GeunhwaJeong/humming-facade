// 로컬넷 부트스트랩(하늘 SDK판): NS PTB1/PTB2 + feed::create. 상수는 이번 regenesis 배포값.
import fs from 'node:fs'
import { Transaction } from '@haneullabs/haneul/transactions'
import { Ed25519Keypair } from '@haneullabs/haneul/keypairs/ed25519'
import { HaneulGrpcClient } from '@haneullabs/haneul/grpc'

const HUM_PKG = '0x352943fd632e3b7d98c359ea50545cc47f6f77d64621965d76167c94bd0a2690'
const NS_PKG = '0x6f96d762b872bab1a53ccf1c9379a389d077ce3c9171b092e4cfc37d2d322bae'
const DENY_PKG = '0x9e99fec9c8be82d2fc46204e17c3a03375b1c182f8e80102ab2f4274b634753f'
const SUB_PKG = '0xc7df7969b51be7c0d777c2b01a0e8f040c4a12e0cc3eece1311d3e4a9603fa2c'
const NS_OBJ = '0x57162618845c8802ab97824af2c8aa8e84a74c817243b1d2e2ab8277a2ebc79b'
const ADMIN_CAP = '0x0e73772f0cc46f7cfe7d1c14b7ff25f0c0241a3c27197c3f9069fed27466f91f'
const ADMIN = '0x721790f36e8ae1c71849c5b9897b2a9a150015da1ca37be20f74fbdea4580103' // CLI active (publisher, AdminCap owner)
const APP_WALLET = '0x7e6dc9a774eb022d809e3ab7e5d578126e98e5e351f07aee820951dd2b80c3de'
const CLOCK = '0x6'
const client = new HaneulGrpcClient({ network: 'localnet', baseUrl: 'http://127.0.0.1:9000', format: 'binary' })
function keypairOf(address) {
  const entries = JSON.parse(fs.readFileSync(`${process.env.HOME}/.haneul/haneul_config/haneul.keystore`, 'utf8'))
  for (const b64 of entries) {
    const raw = Buffer.from(b64, 'base64')
    if (raw.length !== 33 || raw[0] !== 0x00) continue
    const kp = Ed25519Keypair.fromSecretKey(raw.subarray(1))
    if (kp.toHaneulAddress() === address) return kp
  }
  throw new Error(`no key for ${address}`)
}
async function run(label, signer, build) {
  const tx = new Transaction(); tx.setGasBudget(300_000_000); build(tx)
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { objectChanges: true } })
  const r = res.Transaction ?? res.FailedTransaction
  if (res.$kind !== 'Transaction') throw new Error(`${label} failed: ${r?.status?.error?.message ?? 'unknown'} (${r?.digest})`)
  await client.waitForTransaction({ digest: r.digest })
  console.log(`${label} OK ${r.digest}`)
  for (const oc of r.objectChanges ?? []) if (oc.$kind === 'CreatedObject' || oc.type === 'created' || oc.created) console.log('  created', (oc.objectType ?? oc.created?.objectType ?? '').split('::').slice(1).join('::').slice(0, 70), oc.objectId ?? oc.created?.objectId)
}
const admin = keypairOf(ADMIN), app = keypairOf(APP_WALLET)
await run('PTB1 (NS setup + reserve hum.haneul → APP_WALLET)', admin, tx => {
  tx.moveCall({ target: `${NS_PKG}::admin::authorize`, arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ)] })
  const reg = tx.moveCall({ target: `${NS_PKG}::registry::new`, arguments: [tx.object(ADMIN_CAP)] })
  tx.moveCall({ target: `${NS_PKG}::haneulns::add_registry`, typeArguments: [`${NS_PKG}::registry::Registry`], arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ), reg] })
  const em = tx.moveCall({ target: '0x2::vec_map::empty', typeArguments: ['0x1::string::String', '0x1::string::String'], arguments: [] })
  const cfg = tx.moveCall({ target: `${NS_PKG}::core_config::new`, arguments: [tx.pure.vector('u8', []), tx.pure.u8(3), tx.pure.u8(63), tx.pure.u8(1), tx.pure.u8(5), tx.pure.vector('string', ['haneul']), em] })
  tx.moveCall({ target: `${NS_PKG}::haneulns::add_config`, typeArguments: [`${NS_PKG}::core_config::CoreConfig`], arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ), cfg] })
  const nft = tx.moveCall({ target: `${NS_PKG}::admin::reserve_domain`, arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ), tx.pure.string('hum.haneul'), tx.pure.u8(3), tx.object(CLOCK)] })
  tx.transferObjects([nft], tx.pure.address(APP_WALLET))
})
await run('PTB2 (denylist + subdomains app)', admin, tx => {
  tx.moveCall({ target: `${DENY_PKG}::denylist::setup`, arguments: [tx.object(NS_OBJ), tx.object(ADMIN_CAP)] })
  tx.moveCall({ target: `${NS_PKG}::haneulns::authorize_app`, typeArguments: [`${SUB_PKG}::subdomains::SubDomains`], arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ)] })
  const cfg = tx.moveCall({ target: `${SUB_PKG}::config::default`, arguments: [] })
  tx.moveCall({ target: `${NS_PKG}::haneulns::add_config`, typeArguments: [`${SUB_PKG}::config::SubDomainConfig`], arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ), cfg] })
})
await run('feed::create (caps → APP_WALLET)', app, tx => {
  const caps = tx.moveCall({ target: `${HUM_PKG}::feed::create`, arguments: [tx.pure.string('ipfs://humming-feed')] })
  tx.transferObjects([caps[0], caps[1]], tx.pure.address(APP_WALLET))
})
