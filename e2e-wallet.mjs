// E2E: 지갑 사이드바 패널 — 진입점 → 홈(잔고·활동) → 주소 복사 → 받기(QR) →
// 풀주소 복사 → 빈 지갑 상태(응답 목킹)까지 Uniswap 스타일 UI 전 구간 검증.
import { chromium } from 'playwright'

const APP = 'http://localhost:19006'
const SHOT = n => `/Users/jeong-gh/humming-facade/e2e-wallet-${n}.png`
const tid = id => `[data-testid="${id}"]`
const BOB = '0x8af0079f1c61849b3c5563ba123ed5413fcc05c8963fd0ecf81bd8220b067014'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
})
const page = await context.newPage()

console.log('1) 로그인 (bob)')
await page.goto(APP, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForTimeout(6000)
const dialog = page.locator('[role="dialog"]')
if (await dialog.count()) {
  await dialog.locator('[role="button"]:has-text("로그인"), a:has-text("로그인"), [role="button"]:has-text("Sign in")').last().click({ timeout: 30000 })
} else {
  await page.locator(`${tid('signInButton')}, [role="button"]:has-text("로그인")`).first().click({ timeout: 60000 })
}
await page.waitForSelector(tid('loginUsernameInput'), { timeout: 30000 })
await page.fill(tid('loginUsernameInput'), 'bob.hum.haneul')
await page.fill(tid('loginPasswordInput'), 'humming')
await page.click(tid('loginNextButton'))
await page.waitForTimeout(5000)

console.log('2) 사이드바 지갑 메뉴 확인 → 클릭')
await page.waitForSelector(tid('hummingWalletNavItem'), { timeout: 60000 })
await page.locator(tid('hummingWalletNavItem')).click()

console.log('3) 지갑 홈: 잔고 + 축약 주소 + 최근 활동')
await page.waitForSelector(tid('hummingWalletBalance'), { timeout: 30000 })
const balanceText = await page.locator(tid('hummingWalletBalance')).innerText()
console.log(`   ✅ 잔고 표시: ${balanceText}`)
const pillText = await page.locator(tid('hummingWalletAddressPill')).innerText()
if (!pillText.includes('0x8af0') || !pillText.includes('7014')) throw new Error(`주소 축약 오류: ${pillText}`)
console.log(`   ✅ 축약 주소: ${pillText.trim()}`)
const activityText = await page.locator('text=최근 활동').count()
console.log(`   ✅ 최근 활동 섹션: ${activityText}개`)
await page.waitForTimeout(800)
await page.screenshot({ path: SHOT('1-home') })

console.log('4) 축약 주소 필 클릭 = 복사')
await page.locator(tid('hummingWalletAddressPill')).click()
await page.waitForTimeout(300)
const clip1 = await page.evaluate(() => navigator.clipboard.readText())
if (clip1 !== BOB) throw new Error(`클립보드 불일치: ${clip1}`)
console.log('   ✅ 클립보드 = bob 풀 주소')
await page.screenshot({ path: SHOT('2-copied-toast') })

console.log('5) 받기 → QR 화면')
await page.locator(tid('hummingWalletReceiveBtn')).click()
await page.waitForSelector(tid('hummingWalletQr'), { timeout: 15000 })
const fullAddr = await page.locator(tid('hummingWalletFullAddress')).innerText()
if (!fullAddr.includes(BOB)) throw new Error(`풀 주소 미표시: ${fullAddr}`)
console.log('   ✅ QR + 풀 주소 표시')
await page.waitForTimeout(800)
await page.screenshot({ path: SHOT('3-receive-qr') })

console.log('6) 풀 주소 박스 클릭 = 복사 → 뒤로가기')
await page.evaluate(() => navigator.clipboard.writeText(''))
await page.locator(tid('hummingWalletFullAddress')).click()
await page.waitForTimeout(300)
const clip2 = await page.evaluate(() => navigator.clipboard.readText())
if (clip2 !== BOB) throw new Error(`풀주소 클립보드 불일치: ${clip2}`)
console.log('   ✅ 풀 주소 복사 동작')
await page.locator(tid('hummingWalletBackBtn')).click()
await page.waitForSelector(tid('hummingWalletBalance'), { timeout: 15000 })
console.log('   ✅ 지갑 홈 복귀')

console.log('7) 빈 지갑 상태 (getInfo 응답 목킹: 잔고 0·활동 0)')
await page.keyboard.press('Escape')
await page.waitForTimeout(800)
await page.route('**/xrpc/app.humming.wallet.getInfo*', async route => {
  const res = await route.fetch()
  const json = await res.json()
  json.balanceGeunhwa = 0
  json.activity = []
  await route.fulfill({ response: res, json })
})
await page.locator(tid('hummingWalletNavItem')).click()
await page.waitForSelector(tid('hummingWalletEmpty'), { timeout: 30000 })
const emptyText = await page.locator(tid('hummingWalletEmpty')).innerText()
console.log(`   ✅ 빈 지갑 카드: ${emptyText.split('\n')[0]}`)
await page.waitForTimeout(500)
await page.screenshot({ path: SHOT('4-empty-state') })

await browser.close()
console.log('\n🎉 지갑 E2E 전 항목 통과')
