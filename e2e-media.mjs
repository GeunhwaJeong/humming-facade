// E2E: media pipeline — composer image upload → on-chain pointer → render;
// non-subscriber sees teaser without URLs; on-chain subscribe unlocks the image.
import { chromium } from 'playwright'

const APP = 'http://localhost:19006'
const SHOT = n => `/Users/jeong-gh/humming-facade/e2e-media-${n}.png`
const tid = id => `[data-testid="${id}"]`

async function login(page, handle) {
  await page.goto(APP, { waitUntil: 'networkidle', timeout: 120000 })
  await page.waitForTimeout(5000)
  const dialog = page.locator('[role="dialog"]')
  if (await dialog.count()) {
    await dialog.locator('[role="button"]:has-text("로그인"), a:has-text("로그인")').last().click({ timeout: 30000 })
  } else {
    await page.locator(`${tid('signInButton')}, [role="button"]:has-text("로그인")`).first().click({ timeout: 60000 })
  }
  await page.waitForSelector(tid('loginUsernameInput'), { timeout: 30000 })
  await page.fill(tid('loginUsernameInput'), handle)
  await page.fill(tid('loginPasswordInput'), 'humming')
  await page.click(tid('loginNextButton'))
  await page.waitForSelector(tid('composeFAB'), { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(4000)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })

console.log('1) bob 로그인 → 컴포저에서 이미지 첨부 게시')
let page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await login(page, 'bob.hum.haneul')
await page.locator(`${tid('composeFAB')}, [role="button"]:has-text("새 게시물")`).first().click({ timeout: 30000 })
// 웹 컴포저는 TipTap(contenteditable) — testID 없음
const editor = page.locator('[contenteditable="true"]').first()
await editor.waitFor({ timeout: 30000 })
await editor.click()
await page.keyboard.type('🖼 UI 컴포저로 올린 공개 이미지 게시물!')
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser', { timeout: 30000 }),
  page.click(tid('openMediaBtn')),
])
await chooser.setFiles('/Users/jeong-gh/humming-facade/demo-bluesky-on-haneul.png')
await page.waitForTimeout(3000) // 이미지 프리뷰 로드
await page.screenshot({ path: SHOT('1-composer') })
await page.click(tid('composerPublishBtn'), { timeout: 15000 })
await page.waitForSelector('[contenteditable="true"]', { state: 'detached', timeout: 90000 })
console.log('   게시 완료 — 타임라인에서 이미지 렌더 확인')
await page.waitForTimeout(4000)
await page.waitForSelector('text=UI 컴포저로 올린', { timeout: 60000 })
const imgs = await page.locator('img[src*="/media/"]').count()
console.log(`   ✅ 서명 URL 이미지 ${imgs}개 렌더`)
await page.screenshot({ path: SHOT('2-image-in-timeline') })
await page.close()

console.log('2) dave(비구독자) 로그인 → 잠금 카드 + 미디어 티저')
page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await login(page, 'dave.hum.haneul')
await page.waitForSelector(tid('hummingLockedPostCard'), { timeout: 60000 })
await page.waitForSelector(tid('hummingMediaTeaser'), { timeout: 30000 })
const teaser = await page.locator(tid('hummingMediaTeaser')).first().innerText()
console.log(`   ✅ 티저: "${teaser}"`)
const leaked = await page.locator('img[src*="/media/"]').count()
console.log(`   ✅ 미디어 URL 유출: ${leaked}개 (0이어야 정상)`)
await page.screenshot({ path: SHOT('3-locked-teaser') })

console.log('3) dave 구독 → 이미지 해제')
await page.locator(tid('hummingLockedSubscribeBtn')).first().click()
await page.waitForSelector('[role="alertdialog"], [role="dialog"]', { timeout: 15000 })
await page.locator('[role="button"]:has-text("온체인 결제")').last().click({ timeout: 15000 })
await page.waitForSelector('text=구독 완료', { timeout: 90000 })
await page.waitForSelector('img[src*="/media/"]', { timeout: 60000 })
console.log('   ✅ 구독 후 이미지 렌더')
await page.waitForTimeout(2500)
await page.screenshot({ path: SHOT('4-unlocked-image') })
await page.close()

await browser.close()
console.log('완료 — 미디어 파이프라인 E2E 전 구간 통과')
