// Diagnose what the Bluesky web app renders on load.
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', m => console.log(`[${m.type()}]`, m.text().slice(0, 200)))
page.on('requestfailed', r => console.log('❌ 요청 실패:', r.url().slice(0, 120)))

await page.goto('http://localhost:19006', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(15000)

const testids = await page.$$eval('[data-testid]', els =>
  [...new Set(els.map(e => e.getAttribute('data-testid')))].slice(0, 40),
)
console.log('보이는 testID들:', JSON.stringify(testids))
console.log('본문 텍스트 앞부분:', (await page.innerText('body').catch(() => '')).slice(0, 300))
await page.screenshot({ path: '/Users/jeong-gh/humming-facade/probe.png' })
console.log('📸 /Users/jeong-gh/humming-facade/probe.png')
await browser.close()
