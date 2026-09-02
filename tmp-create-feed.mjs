// 로컬넷 feed::create — caps 2개는 서명자에게 전송 (CLI로는 튜플 소비 불가라 SDK 경유)
import fs from 'node:fs'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SuiGrpcClient } from '@mysten/sui/grpc'

const [PKG, SIGNER_ADDR] = process.argv.slice(2)
if (!PKG || !SIGNER_ADDR) throw new Error('usage: create-feed.mjs <PKG> <signer-address>')

const client = new SuiGrpcClient({ network: 'localnet', baseUrl: 'http://127.0.0.1:9000', format: 'binary' })

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
const signer = keypairOf(SIGNER_ADDR)

const tx = new Transaction()
tx.setGasBudget(100_000_000)
const caps = tx.moveCall({ target: `${PKG}::feed::create`, arguments: [tx.pure.string('ipfs://humming-feed')] })
tx.transferObjects([caps[0], caps[1]], SIGNER_ADDR)

const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { events: true, objectChanges: true } })
const r = res.Transaction ?? res.FailedTransaction
if (res.$kind !== 'Transaction') throw new Error(`feed::create failed: ${JSON.stringify(r?.status ?? res).slice(0, 400)}`)
await client.waitForTransaction({ digest: r.digest })
console.log('digest', r.digest)
for (const oc of r.objectChanges ?? []) console.log(JSON.stringify(oc))
