import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto('http://localhost:19006', { timeout: 120000 })
// 웹팩 첫 컴파일 대기 — 앱이 하이드레이트되면 버튼이 생긴다
await page.waitForSelector('button, [role="button"]', { timeout: 300000 })
await page.waitForTimeout(3000)
const txt = (await page.textContent('body'))?.replace(/\s+/g,' ').slice(0, 300)
console.log('BODY:', txt)
await page.screenshot({ path: '/private/tmp/claude-501/-Users-jeong-gh-haneul/30d9a39a-85eb-4f1d-8ae0-d53c406b78a3/scratchpad/ui-diag.png' })
await browser.close()
