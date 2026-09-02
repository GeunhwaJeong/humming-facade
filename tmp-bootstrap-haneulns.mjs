// haneulns 로컬넷 부트스트랩 (2026-08-20 E2E 세션 재작성판)
// PTB1: admin::authorize + registry/add_registry + core_config/add_config + reserve_domain(hum.haneul)
// PTB2: denylist::setup + authorize_app<SubDomains> + add_config<SubDomainConfig>
import fs from 'node:fs'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SuiGrpcClient } from '@mysten/sui/grpc'

const NS_PKG = '0xc5244cd4c23e54cdb72ae5f76d6519a242d3bcf7ebcfc0dfa9e14200bc921c53'
const DENY_PKG = '0xed2196c385f5cdabf3e65c0fb926d5099bdac49b5c6b905be12a43a666755af1'
const SUB_PKG = '0x2444d8a930675411d84ecac203fce5d54f6d9303bb81e6b8fa2613e2cd60c334'
const NS_OBJ = '0x9f91f873f23b6356b85499356108b60b28715ef0303ad2ad4a8e008f479530da'
const ADMIN_CAP = '0x781721e164e31d930dc95a018f1ee18603b92db59b275a3fa0bc1ba1688ebbc5'
const APP_WALLET = '0x7e6dc9a774eb022d809e3ab7e5d578126e98e5e351f07aee820951dd2b80c3de'
const CLOCK = '0x6'

const client = new SuiGrpcClient({ network: 'localnet', baseUrl: 'http://127.0.0.1:9000', format: 'binary' })

// CLI 키스토어에서 app-wallet 키 로드 (읽기 전용)
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
const signer = keypairOf(APP_WALLET)

async function run(label, build) {
  const tx = new Transaction()
  tx.setGasBudget(200_000_000)
  build(tx)
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { events: true, objectChanges: true } })
  const r = res.Transaction ?? res.FailedTransaction
  if (res.$kind !== 'Transaction') throw new Error(`${label} failed: ${r?.status?.error?.message ?? 'unknown'} (${r?.digest})`)
  await client.waitForTransaction({ digest: r.digest })
  console.log(`${label} OK digest=${r.digest}`)
  for (const oc of r.objectChanges ?? []) {
    if (oc.$kind === 'CreatedObject' || oc.created) console.log('  created', JSON.stringify(oc))
  }
  return r
}

const step = process.argv[2] || 'all'

if (step === 'all' || step === '1') {
  const r1 = await run('PTB1', tx => {
    tx.moveCall({ target: `${NS_PKG}::admin::authorize`, arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ)] })
    const reg = tx.moveCall({ target: `${NS_PKG}::registry::new`, arguments: [tx.object(ADMIN_CAP)] })
    tx.moveCall({
      target: `${NS_PKG}::haneulns::add_registry`,
      typeArguments: [`${NS_PKG}::registry::Registry`],
      arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ), reg],
    })
    const em = tx.moveCall({
      target: '0x2::vec_map::empty',
      typeArguments: ['0x1::string::String', '0x1::string::String'],
      arguments: [],
    })
    const cfg = tx.moveCall({
      target: `${NS_PKG}::core_config::new`,
      arguments: [
        tx.pure.vector('u8', []), tx.pure.u8(3), tx.pure.u8(63), tx.pure.u8(1), tx.pure.u8(5),
        tx.pure.vector('string', ['haneul']), em,
      ],
    })
    tx.moveCall({
      target: `${NS_PKG}::haneulns::add_config`,
      typeArguments: [`${NS_PKG}::core_config::CoreConfig`],
      arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ), cfg],
    })
    const nft = tx.moveCall({
      target: `${NS_PKG}::admin::reserve_domain`,
      arguments: [
        tx.object(ADMIN_CAP), tx.object(NS_OBJ), tx.pure.string('hum.haneul'), tx.pure.u8(3), tx.object(CLOCK),
      ],
    })
    tx.transferObjects([nft], tx.pure.address(APP_WALLET))
  })
}

if (step === 'all' || step === '2') {
  await run('PTB2', tx => {
    tx.moveCall({ target: `${DENY_PKG}::denylist::setup`, arguments: [tx.object(NS_OBJ), tx.object(ADMIN_CAP)] })
    tx.moveCall({
      target: `${NS_PKG}::haneulns::authorize_app`,
      typeArguments: [`${SUB_PKG}::subdomains::SubDomains`],
      arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ)],
    })
    const cfg = tx.moveCall({ target: `${SUB_PKG}::config::default`, arguments: [] })
    tx.moveCall({
      target: `${NS_PKG}::haneulns::add_config`,
      typeArguments: [`${SUB_PKG}::config::SubDomainConfig`],
      arguments: [tx.object(ADMIN_CAP), tx.object(NS_OBJ), cfg],
    })
  })
}
