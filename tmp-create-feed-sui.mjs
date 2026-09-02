import fs from 'node:fs'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SuiGrpcClient } from '@mysten/sui/grpc'

const PKG = '0xce50ab162a62c1a7a22f39d525a8f1aca13e8ede2a6527dbfc0f669a510ccb37'
const APP = '0x52d57e4c9f8f0216ccd66c503b7188f36d4a7b70ef803c003a1a0ba48669a273'
const keys = JSON.parse(fs.readFileSync(new URL('file:///Users/jeong-gh/humming-facade/wallet-keys.sui-testnet.json'), 'utf8'))
const signer = Ed25519Keypair.fromSecretKey(keys[APP])
const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443', format: 'binary' })

const tx = new Transaction()
tx.setGasBudget(100_000_000)
const caps = tx.moveCall({ target: `${PKG}::feed::create`, arguments: [tx.pure.string('ipfs://humming-feed')] })
tx.transferObjects([caps[0], caps[1]], APP)
const res = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { objectChanges: true } })
const r = res.Transaction ?? res.FailedTransaction
if (res.$kind !== 'Transaction') throw new Error(JSON.stringify(r?.status).slice(0, 300))
console.log('digest:', r.digest)
for (const oc of r.objectChanges ?? []) {
  if (oc.type === 'created') console.log('created:', oc.objectType?.replace(PKG, 'PKG'), oc.objectId)
}
