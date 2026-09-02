import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0,200)))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0,200)) })
page.on('requestfailed', r => console.log('REQFAIL:', r.url().slice(0,100), r.failure()?.errorText))
await page.goto('http://localhost:19006', { timeout: 120000 })
await page.waitForTimeout(20000)
await browser.close()
