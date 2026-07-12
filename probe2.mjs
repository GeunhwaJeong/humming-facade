// Quick probe: login as alice, dump what the home screen actually shows.
import { chromium } from 'playwright'

const APP = 'http://localhost:19006'
const tid = id => `[data-testid="${id}"]`

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(APP, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForTimeout(6000)

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
await page.fill(tid('loginUsernameInput'), 'alice.hum.haneul')
await page.fill(tid('loginPasswordInput'), 'humming')
await page.click(tid('loginNextButton'))
await page.waitForTimeout(15000)

console.log('URL:', page.url())
console.log('--- body text (앞 1200자) ---')
console.log((await page.innerText('body').catch(() => '(none)')).slice(0, 1200))
await page.screenshot({ path: '/Users/jeong-gh/humming-facade/probe2.png' })
console.log('📸 probe2.png')
await browser.close()
