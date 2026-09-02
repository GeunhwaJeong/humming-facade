import fs from 'node:fs'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SuiGrpcClient } from '@mysten/sui/grpc'
const PKG = '0x5ab0715d3f41a0ce36cc0e9b76dba979fdaaded65b34e4ff611f12d1bd190b93'
const APP = '0x69c79e77fb634b89a1bb82ed6e58f6f1d81fb44bd12f4ec9c64b53542733dc79'
const keys = JSON.parse(fs.readFileSync('./wallet-keys.sui-localnet.json', 'utf8'))
const signer = Ed25519Keypair.fromSecretKey(keys[APP])
const client = new SuiGrpcClient({ network: 'localnet', baseUrl: 'http://127.0.0.1:9000', format: 'binary' })
const tx = new Transaction()
tx.setGasBudget(100_000_000)
const caps = tx.moveCall({ target: `${PKG}::feed::create`, arguments: [tx.pure.string('ipfs://humming-feed')] })
tx.transferObjects([caps[0], caps[1]], APP)
const res = await client.signAndExecuteTransaction({ transaction: tx, signer })
const r = res.Transaction ?? res.FailedTransaction
if (res.$kind !== 'Transaction') throw new Error(JSON.stringify(r?.status).slice(0,300))
console.log('digest:', r.digest)
