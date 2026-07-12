// E2E: OnlyFans-style locked UX — locked cards in timeline, fully locked
// profile, inline subscribe CTA unlocking everything on-chain.
import { chromium } from 'playwright'

const APP = 'http://localhost:19006'
const RPC = 'http://127.0.0.1:9000'
const ALICE = '0xa5a8018f9eea5421ff6e9001bb0b8b502e5dd8d40265c38b728c3a1f5e5cf3f0'
const CAROL = '0x721790f36e8ae1c71849c5b9897b2a9a150015da1ca37be20f74fbdea4580103'
const SHOT = n => `/Users/jeong-gh/humming-facade/e2e-lock-${n}.png`
const tid = id => `[data-testid="${id}"]`

async function balance(addr) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'haneulx_getBalance', params: [addr, '0x2::haneul::HANEUL'] }),
  })
  return Number((await res.json()).result.totalBalance) / 1e9
}
const before = { alice: await balance(ALICE), carol: await balance(CAROL) }
console.log(`잔고(전): alice=${before.alice.toFixed(4)} carol=${before.carol.toFixed(4)}`)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

console.log('1) 로그인 (alice)')
await page.goto(APP, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForTimeout(6000)
const dialog = page.locator('[role="dialog"]')
if (await dialog.count()) {
  await dialog.locator('[role="button"]:has-text("로그인"), a:has-text("로그인"), [role="button"]:has-text("Sign in")').last().click({ timeout: 30000 })
} else {
  await page.locator(`${tid('signInButton')}, [role="button"]:has-text("로그인")`).first().click({ timeout: 60000 })
}
await page.waitForSelector(tid('loginUsernameInput'), { timeout: 30000 })
await page.fill(tid('loginUsernameInput'), 'alice.hum.haneul')
await page.fill(tid('loginPasswordInput'), 'humming')
await page.click(tid('loginNextButton'))

console.log('2) 타임라인: carol의 글이 네이티브 잠금 카드로')
await page.waitForSelector(tid('hummingLockedPostCard'), { timeout: 60000 })
const cardCount = await page.locator(tid('hummingLockedPostCard')).count()
console.log(`   ✅ 잠금 카드 ${cardCount}개`)
await page.waitForTimeout(1500)
await page.screenshot({ path: SHOT('1-timeline-cards') })

console.log('3) carol 프로필: 전면 잠금 (구독 카드 + 게시물 숨김)')
await page.goto(`${APP}/profile/carol.hum.haneul`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector(tid('hummingProfileSubscribeCard'), { timeout: 30000 })
const cardText = await page.locator(tid('hummingProfileSubscribeCard')).innerText()
console.log('   구독 카드:', cardText.replace(/\n/g, ' | '))
const carolPostVisible = await page.locator('text=Carol의 첫 게시물').count()
console.log(`   ✅ 개별 게시물 노출: ${carolPostVisible}개 (0이어야 정상)`)
await page.screenshot({ path: SHOT('2-locked-profile') })

console.log('4) 홈으로 → 잠금 카드의 인라인 구독 CTA 클릭')
await page.goto(APP, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector(tid('hummingLockedSubscribeBtn'), { timeout: 30000 })
await page.locator(tid('hummingLockedSubscribeBtn')).first().click()
await page.waitForSelector('[role="alertdialog"], [role="dialog"]', { timeout: 15000 })
await page.screenshot({ path: SHOT('3-inline-prompt') })
await page.locator('[role="button"]:has-text("온체인 결제")').last().click({ timeout: 15000 })
await page.waitForSelector('text=구독 완료', { timeout: 90000 })
console.log('   ✅ 구독 완료 토스트')
await page.screenshot({ path: SHOT('4-subscribed-toast') })

console.log('5) 타임라인에서 carol 본문 해제 확인')
await page.waitForSelector('text=Carol의 첫 게시물', { timeout: 60000 })
console.log('   ✅ carol 본문 열림')
await page.waitForTimeout(1000)
await page.screenshot({ path: SHOT('5-unlocked-timeline') })

console.log('6) carol 프로필 재방문: 구독 중 + 게시물 노출')
await page.goto(`${APP}/profile/carol.hum.haneul`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector(tid('hummingProfileSubscribedBtn'), { timeout: 30000 })
await page.waitForSelector('text=Carol의 첫 게시물', { timeout: 30000 })
console.log('   ✅ 프로필 잠금 해제')
await page.screenshot({ path: SHOT('6-unlocked-profile') })

console.log('7) 게시물 상세: 팁 보내기 라벨')
await page.locator('text=Carol의 첫 게시물').first().click()
await page.waitForSelector('text=팁 보내기', { timeout: 30000 })
console.log('   ✅ 팁 보내기 라벨 (big 모드)')
await page.screenshot({ path: SHOT('7-tip-label') })

await browser.close()
const after = { alice: await balance(ALICE), carol: await balance(CAROL) }
console.log(`잔고(후): alice=${after.alice.toFixed(4)} carol=${after.carol.toFixed(4)}`)
console.log(`이동: alice ${(after.alice - before.alice).toFixed(4)} / carol +${(after.carol - before.carol).toFixed(4)} (0.5 구독, carol=트레저리 아님 → 0.475+0.025는 각각 carol/bob)`)
console.log('완료')
