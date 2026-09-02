import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://localhost:19006', { timeout: 120000 })
await page.waitForSelector('button, [role="button"]', { timeout: 180000 }).catch(() => {})
await page.waitForTimeout(8000)
let body = (await page.textContent('body')) ?? ''
if (body.includes('JavaScript is not enabled')) {
  await page.reload(); await page.waitForTimeout(15000)
  body = (await page.textContent('body')) ?? ''
}
console.log('하이드레이트:', !body.includes('JavaScript is not enabled'))
// 로그인 시도
const signIn = page.getByRole('button', { name: /sign in|로그인/i }).first()
await signIn.click({ timeout: 20000 })
await page.waitForTimeout(2500)
const user = page.locator('[data-testid="loginUsernameInput"], input[autocomplete="username"]').first()
await user.fill('mina.hum.sui')
const pw = page.locator('[data-testid="loginPasswordInput"], input[type="password"]').first()
await pw.fill('Spike-2026-pass!')
await page.getByRole('button', { name: /^(sign in|next|로그인|다음)$/i }).last().click()
await page.waitForTimeout(9000)
body = (await page.textContent('body')) ?? ''
console.log('타임라인에 sora 글 보임:', body.includes('usdc payments live') || body.includes('first post'))
await page.screenshot({ path: '/private/tmp/claude-501/-Users-jeong-gh-haneul/30d9a39a-85eb-4f1d-8ae0-d53c406b78a3/scratchpad/ui-smoke.png' })
await browser.close()
