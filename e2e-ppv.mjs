// E2E: PPV single-post purchase — erin (no subscriptions) buys one gated
// post; it unlocks permanently while the subscription stays off.
import { chromium } from 'playwright'

const APP = 'http://localhost:19006'
const RPC = 'http://127.0.0.1:9000'
const ERIN = '0x454b30d5ca6c69048cf050368d3bf3c75fd7ed32427ac1c24b9d696dba9bd1a7'
const BOB = '0x8af0079f1c61849b3c5563ba123ed5413fcc05c8963fd0ecf81bd8220b067014'
const SHOT = n => `/Users/jeong-gh/humming-facade/e2e-ppv-${n}.png`
const tid = id => `[data-testid="${id}"]`

async function balance(addr) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'haneulx_getBalance', params: [addr, '0x2::haneul::HANEUL'] }),
  })
  return Number((await res.json()).result.totalBalance) / 1e9
}
const before = { erin: await balance(ERIN), bob: await balance(BOB) }
console.log(`잔고(전): erin=${before.erin.toFixed(4)} bob=${before.bob.toFixed(4)}`)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

console.log('1) erin 로그인 (아무 구독 없음)')
await page.goto(APP, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForTimeout(5000)
const dialog = page.locator('[role="dialog"]')
if (await dialog.count()) {
  await dialog.locator('[role="button"]:has-text("로그인"), a:has-text("로그인")').last().click({ timeout: 30000 })
} else {
  await page.locator(`${tid('signInButton')}, [role="button"]:has-text("로그인")`).first().click({ timeout: 60000 })
}
await page.waitForSelector(tid('loginUsernameInput'), { timeout: 30000 })
await page.fill(tid('loginUsernameInput'), 'erin.hum.haneul')
await page.fill(tid('loginPasswordInput'), 'humming')
await page.click(tid('loginNextButton'))

console.log('2) 잠금 카드: 구독 + 단건 구매 버튼 둘 다')
await page.waitForSelector(tid('hummingPurchaseBtn'), { timeout: 60000 })
const buyText = await page.locator(tid('hummingPurchaseBtn')).first().innerText()
console.log(`   구매 버튼: "${buyText}"`)
await page.waitForTimeout(1500)
await page.screenshot({ path: SHOT('1-both-buttons') })

console.log('3) 단건 구매 (온체인)')
await page.locator(tid('hummingPurchaseBtn')).first().click()
await page.waitForSelector('[role="alertdialog"], [role="dialog"]', { timeout: 15000 })
await page.screenshot({ path: SHOT('2-purchase-prompt') })
await page.locator('[role="button"]:has-text("온체인 결제")').last().click({ timeout: 15000 })
await page.waitForSelector('text=구매 완료', { timeout: 90000 })
console.log('   ✅ 구매 완료 토스트')

console.log('4) 이미지 해제 + 다른 잠금 글은 여전히 잠김')
await page.waitForSelector('img[src*="/media/"]', { timeout: 60000 })
const stillLocked = await page.locator(tid('hummingLockedPostCard')).count()
console.log(`   ✅ 구매한 글 이미지 렌더 / 남은 잠금 카드 ${stillLocked}개 (carol 글 등 — 구독 안 샀으니 잠겨 있어야)`)
await page.waitForTimeout(2000)
await page.screenshot({ path: SHOT('3-unlocked-others-locked') })

console.log('5) bob 프로필: 구독 상태는 여전히 미구독이어야')
await page.goto(`${APP}/profile/bob.hum.haneul`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector(tid('hummingProfileSubscribeCard'), { timeout: 30000 })
const cardText = await page.locator(tid('hummingProfileSubscribeCard')).innerText()
console.log(`   구독 카드: ${cardText.split('\n')[1] || cardText}`.slice(0, 60))
await page.screenshot({ path: SHOT('4-still-unsubscribed') })

await browser.close()
const after = { erin: await balance(ERIN), bob: await balance(BOB) }
console.log(`잔고(후): erin=${after.erin.toFixed(4)} bob=${after.bob.toFixed(4)}`)
console.log(`이동: erin ${(after.erin - before.erin).toFixed(4)} / bob +${(after.bob - before.bob).toFixed(4)} (0.5 단건, bob=작성자+트레저리)`)
console.log('완료')
