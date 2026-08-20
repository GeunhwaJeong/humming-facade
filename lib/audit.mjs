// 결제 감사 로그: 돈이 움직이는 연산(구독·구매·팁) 1건당 JSON 한 줄을 append한다.
// 저널과 같은 append-only jsonl 규약이라 크래시로 잘려도 마지막 줄만 손실된다.
// 목적은 분쟁 재구성이다: 요청 ID로 로그 줄과 서버 로그를 잇고, digest로 온체인
// 사실과 대조한다. 감사 기록 실패가 결제 자체를 막아서는 안 되므로 오류는 삼킨다.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { NETWORK } from './config.mjs'

const AUDIT_URL = new URL(`../audit.${NETWORK}.jsonl`, import.meta.url)

export const newRequestId = () => crypto.randomBytes(8).toString('hex')

export function auditMoney(entry) {
  try {
    fs.appendFileSync(AUDIT_URL, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', {
      mode: 0o600,
    })
  } catch (e) {
    console.error(`⚠️ 감사 로그 기록 실패: ${e.message}`)
  }
}
