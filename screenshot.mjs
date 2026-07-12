// Drive the Bluesky web app: login through the Humming facade, capture the timeline.
import { chromium } from 'playwright'

const APP = process.env.APP_URL || 'http://localhost:19006'
const FACADE = 'http://localhost:3025'
const OUT = process.env.OUT || '/Users/jeong-gh/humming-facade/demo-bluesky-on-haneul.png'

const tid = id => `[data-testid="${id}"]`

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', m => {
  if (m.type() === 'error') console.log('🔴 browser:', m.text().slice(0, 160))
})

console.log('1) 앱 접속:', APP)
await page.goto(APP, { waitUntil: 'networkidle', timeout: 120000 })

console.log('2) 로그인 진입')
await page.waitForTimeout(8000) // let the logged-out shell settle
const dialog = page.locator('[role="dialog"]')
if (await dialog.count()) {
  console.log('   (가입 다이얼로그 안의 로그인 링크 클릭)')
  await dialog.locator('[role="button"]:has-text("로그인"), a:has-text("로그인")').last().click({ timeout: 30000 })
} else {
  await page.locator(`${tid('signInButton')}, [role="button"]:has-text("로그인")`).first().click({ timeout: 60000 })
}

console.log('3) 호스팅 프로바이더 → Custom →', FACADE)
await page.click(tid('selectServiceButton'), { timeout: 30000 })
await page.click(`${tid('manualSelectBtn')}, ${tid('customSelectBtn')}`, { timeout: 15000 })
await page.fill(tid('customServerTextInput'), FACADE)
await page.click(tid('doneBtn'))

console.log('4) bob.hum.haneul 로그인')
await page.fill(tid('loginUsernameInput'), 'bob.hum.haneul')
await page.fill(tid('loginPasswordInput'), 'humming')
await page.click(tid('loginNextButton'))

console.log('5) 타임라인 대기 (온체인 게시물 렌더링)')
try {
  await page.waitForSelector('text=온체인', { timeout: 60000 })
  await page.waitForTimeout(4000) // let images/fonts settle
} catch {
  console.log('⚠️ 온체인 텍스트 미발견 — 현재 화면을 그대로 캡처합니다')
  console.log('   화면 텍스트:', (await page.innerText('body').catch(() => '')).slice(0, 400).replace(/\n+/g, ' | '))
}
await page.screenshot({ path: OUT, fullPage: false })
console.log('📸 저장:', OUT)

// bonus: profile screen
try {
  await page.goto(`${APP}/profile/bob.hum.haneul`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: OUT.replace('.png', '-profile.png'), fullPage: false })
  console.log('📸 프로필 저장:', OUT.replace('.png', '-profile.png'))
} catch (e) {
  console.log('프로필 캡처 스킵:', e.message.slice(0, 120))
}

await browser.close()
console.log('완료')
