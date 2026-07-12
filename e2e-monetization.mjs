// E2E: humming-app native subscribe/tip buttons → facade → Haneul chain.
// Run: node e2e-monetization.mjs
import { chromium } from 'playwright'

const APP = process.env.APP_URL || 'http://localhost:19006'
const RPC = 'http://127.0.0.1:9000'
const ALICE = '0xa5a8018f9eea5421ff6e9001bb0b8b502e5dd8d40265c38b728c3a1f5e5cf3f0'
const BOB = '0x8af0079f1c61849b3c5563ba123ed5413fcc05c8963fd0ecf81bd8220b067014'
const SHOT = n => `/Users/jeong-gh/humming-facade/e2e-${n}.png`

const tid = id => `[data-testid="${id}"]`

async function balance(addr) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'haneulx_getBalance', params: [addr, '0x2::haneul::HANEUL'] }),
  })
  return Number((await res.json()).result.totalBalance) / 1e9
}

const before = { alice: await balance(ALICE), bob: await balance(BOB) }
console.log(`잔고(전): alice=${before.alice} bob=${before.bob}`)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', m => {
  if (m.type() === 'error') console.log('🔴 browser:', m.text().slice(0, 200))
})

console.log('1) 앱 접속 (기본 서버 = 파사드여야 함):', APP)
await page.goto(APP, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForTimeout(6000)

console.log('2) 로그인 진입 — 프로바이더 수동 입력 없이')
const dialog = page.locator('[role="dialog"]')
if (await dialog.count()) {
  await dialog
    .locator('[role="button"]:has-text("로그인"), a:has-text("로그인"), [role="button"]:has-text("Sign in"), a:has-text("Sign in")')
    .last()
    .click({ timeout: 30000 })
} else {
  await page
    .locator(`${tid('signInButton')}, [role="button"]:has-text("로그인"), [role="button"]:has-text("Sign in")`)
    .first()
    .click({ timeout: 60000 })
}
await page.waitForSelector(tid('loginUsernameInput'), { timeout: 30000 })
// 핵심 검증: 서버 선택이 이미 파사드를 가리키는지 (수동 입력 단계 소멸)
const serviceText = await page.locator(tid('selectServiceButton')).innerText().catch(() => '(없음)')
console.log('   프로바이더 표시:', serviceText.replace(/\n/g, ' '))

console.log('3) alice.hum.haneul 로그인')
await page.fill(tid('loginUsernameInput'), 'alice.hum.haneul')
await page.fill(tid('loginPasswordInput'), 'humming')
await page.click(tid('loginNextButton'))

console.log('4) 타임라인: alice에게 프리미엄 글이 잠겨 보이는지')
await page.waitForSelector('text=구독자 전용', { timeout: 60000 })
await page.waitForTimeout(2000)
await page.screenshot({ path: SHOT('1-locked-timeline') })
console.log('   ✅ 잠금 카드 확인 📸 e2e-1')

console.log('5) bob 프로필 → 네이티브 구독 버튼')
await page.goto(`${APP}/profile/bob.hum.haneul`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector(tid('hummingSubscribeBtn'), { timeout: 30000 })
const btnText = await page.locator(tid('hummingSubscribeBtn')).innerText()
console.log('   구독 버튼:', btnText.replace(/\n/g, ' '))
await page.screenshot({ path: SHOT('2-subscribe-button') })

console.log('6) 구독 결제 (온체인)')
await page.click(tid('hummingSubscribeBtn'))
await page.waitForSelector('[role="alertdialog"], [role="dialog"]', { timeout: 15000 })
await page.screenshot({ path: SHOT('3-subscribe-prompt') })
await page
  .locator('[role="button"]:has-text("온체인 결제"), [role="button"]:has-text("확인")')
  .last()
  .click({ timeout: 15000 })
await page.waitForSelector('text=구독 완료', { timeout: 90000 })
console.log('   ✅ 구독 완료 토스트')
await page.screenshot({ path: SHOT('4-subscribed-toast') })

console.log('7) 구독 후: 버튼 상태 전환 + 프리미엄 글 해제')
await page.waitForSelector(tid('hummingSubscribedBtn'), { timeout: 30000 })
await page.waitForSelector('text=프리미엄 콘텐츠', { timeout: 30000 })
console.log('   ✅ "구독 중" 버튼 + 프리미엄 본문 열림')
await page.waitForTimeout(1500)
await page.screenshot({ path: SHOT('5-unlocked') })

console.log('8) 팁 버튼 (게시물 컨트롤 줄)')
await page.locator(tid('hummingTipBtn')).first().click({ timeout: 15000 })
await page.waitForSelector('[role="alertdialog"], [role="dialog"]', { timeout: 15000 })
await page.screenshot({ path: SHOT('6-tip-prompt') })
await page
  .locator('[role="button"]:has-text("팁 보내기")')
  .last()
  .click({ timeout: 15000 })
await page.waitForSelector('text=팁 전송 완료', { timeout: 90000 })
console.log('   ✅ 팁 전송 토스트')
await page.screenshot({ path: SHOT('7-tip-sent') })

await browser.close()

const after = { alice: await balance(ALICE), bob: await balance(BOB) }
console.log(`잔고(후): alice=${after.alice} bob=${after.bob}`)
console.log(`이동: alice ${ (after.alice - before.alice).toFixed(4) } / bob +${(after.bob - before.bob).toFixed(4)}`)
console.log('완료 — 구독 1 HANEUL + 팁 0.1 HANEUL이 온체인으로 정산되었는지 위 수치로 확인')
