// Probe: bob (non-subscriber) views carol's fully locked profile — expect the wall panel.
import { chromium } from 'playwright'

const APP = 'http://localhost:19006'
const tid = id => `[data-testid="${id}"]`

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(APP, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForTimeout(6000)
const dialog = page.locator('[role="dialog"]')
if (await dialog.count()) {
  await dialog.locator('[role="button"]:has-text("로그인"), a:has-text("로그인")').last().click({ timeout: 30000 })
} else {
  await page.locator(`${tid('signInButton')}, [role="button"]:has-text("로그인")`).first().click({ timeout: 60000 })
}
await page.waitForSelector(tid('loginUsernameInput'), { timeout: 30000 })
await page.fill(tid('loginUsernameInput'), 'bob.hum.haneul')
await page.fill(tid('loginPasswordInput'), 'humming')
await page.click(tid('loginNextButton'))
await page.waitForSelector('text=Humming에 오신 것을', { timeout: 60000 })

await page.goto(`${APP}/profile/carol.hum.haneul`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector(tid('hummingLockedWallPanel'), { timeout: 30000 })
console.log('✅ 담벼락 패널 렌더')
console.log('   패널 텍스트:', (await page.locator(tid('hummingLockedWallPanel')).innerText()).replace(/\n/g, ' | '))
await page.waitForTimeout(1500)
await page.screenshot({ path: '/Users/jeong-gh/humming-facade/e2e-wall-panel.png' })
console.log('📸 e2e-wall-panel.png')
await browser.close()
