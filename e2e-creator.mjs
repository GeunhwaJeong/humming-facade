// E2E: 크리에이터 되기 — 팬(wasabi)이 사이드바 온보딩으로 크리에이터 전환 →
// 컴포저 열람 설정으로 유료 글 발행 → 다른 계정(erin)에겐 잠김 → 내 수익 대시보드.
// Run: node e2e-creator.mjs
import fs from 'node:fs'
import { chromium } from 'playwright'

const APP = process.env.APP_URL || 'http://localhost:19006'
const RPC = 'http://127.0.0.1:9000'
const PKG = '0xb95712343fe388084e0586512b539d0d69fef908f07a0e0ab453a666407c8c0d'
const HANDLE = 'wasabi.hum.haneul'
const SHOT = n => `/Users/jeong-gh/humming-facade/e2e-creator-${n}.png`
const tid = id => `[data-testid="${id}"]`

const acct = JSON.parse(fs.readFileSync(new URL('./accounts.json', import.meta.url))).find(
  a => a.handle === HANDLE,
)
if (!acct) throw new Error(`${HANDLE} 없음 — 가입 먼저`)

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()).result
}
const events = type =>
  rpc('haneulx_queryEvents', [{ MoveEventType: `${PKG}::${type}` }, null, 50, true]).then(
    r => r.data.map(e => e.parsedJson),
  )

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

console.log('1) wasabi 로그인')
await page.goto(APP, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForTimeout(4000)
const dialog = page.locator('[role="dialog"]').first()
if (await dialog.isVisible().catch(() => false)) {
  await dialog.getByRole('button', { name: /로그인|sign in/i }).first().click()
} else {
  await page.getByRole('button', { name: /로그인|sign in/i }).first().click()
}
await page.waitForSelector(tid('loginUsernameInput'), { timeout: 30000 })
await page.locator(tid('loginUsernameInput')).fill(HANDLE)
await page.locator(tid('loginPasswordInput')).fill(acct.password)
await page.locator(tid('loginNextButton')).click()
await page.waitForTimeout(8000)

console.log('2) 사이드바 "크리에이터 되기" 진입')
await page.waitForSelector(tid('hummingCreatorNavItem'), { timeout: 30000 })
await page.screenshot({ path: SHOT('1-navitem') })
await page.locator(tid('hummingCreatorNavItem')).click()
await page.waitForSelector(tid('hummingBecomeCreatorSubmit'), { timeout: 15000 })
await page.screenshot({ path: SHOT('2-onboarding') })

console.log('3) KYC 동의 → 구독료 2 HANEUL → 티저 모드 → 전환')
await page.locator(tid('hummingKycAgree')).click()
await page.locator(tid('hummingTierPrice')).fill('2')
await page.locator(tid('hummingLockMode-tease')).click()
await page.screenshot({ path: SHOT('3-filled') })
await page.locator(tid('hummingBecomeCreatorSubmit')).click()
await page.waitForTimeout(12000)
await page.screenshot({ path: SHOT('4-converted') })

const tiers = await events('subscriptions::TierCreated')
const myTier = tiers.find(t => t.creator === acct.address)
if (!myTier) throw new Error('온체인 TierCreated 없음 — 전환 실패')
console.log(`   ✅ 온체인 티어: ${Number(myTier.price) / 1e9} HANEUL / ${Number(myTier.period_ms) / 86400000}일`)
const prefs = await events('creator_prefs::PrefsChanged')
const myPrefs = prefs.find(p => p.creator === acct.address)
console.log(`   ✅ 온체인 잠금 설정: locked=${myPrefs?.profile_locked} previews=${myPrefs?.show_locked_previews}`)

console.log('4) 컴포저에서 유료 글 발행 (0.8 HANEUL)')
await page.getByRole('button', { name: /new post|새 게시물/i }).first().click()
await page.waitForTimeout(2000)
const editor = page.locator('[contenteditable="true"]').first()
await editor.click()
await page.keyboard.type('와사비의 첫 유료 글입니다 — 크리에이터 전환 직후 컴포저에서 바로 발행 🎨')
await page.locator(tid('hummingPaywallBtn')).click()
await page.waitForSelector(tid('hummingPaywallPrice'), { timeout: 10000 })
await page.locator(tid('hummingPaywallPrice')).fill('0.8')
await page.screenshot({ path: SHOT('5-paywall-dialog') })
await page.locator(tid('hummingPaywallApply')).click()
await page.waitForTimeout(1000)
await page.locator(tid('composerPublishBtn')).click()
await page.waitForTimeout(10000)
await page.screenshot({ path: SHOT('6-published') })

const pays = await events('paid_posts::PaywallCreated')
const myPay = pays.find(p => Number(p.price) === 800000000)
if (!myPay) throw new Error('PaywallCreated(0.8 HANEUL) 없음 — 유료 글 실패')
console.log(`   ✅ 온체인 페이월: post ${myPay.post_id} @ 0.8 HANEUL`)

console.log('5) erin 시점: 잠겨 보이는지 (파사드 경유)')
const erin = await (await fetch('http://localhost:3025/xrpc/com.atproto.server.createSession', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: 'erin.hum.haneul', password: 'humming' }),
})).json()
const tl = await (await fetch('http://localhost:3025/xrpc/app.bsky.feed.getTimeline?limit=5', {
  headers: { Authorization: `Bearer ${erin.accessJwt}` },
})).json()
const wasabiPost = tl.feed.find(f => f.post.uri.includes(`/${myPay.post_id}`))
console.log(`   erin에게 post ${myPay.post_id}: locked=${wasabiPost?.post.humming?.locked} price=${wasabiPost?.post.humming?.priceGeunhwa}`)

console.log('6) 내 수익 대시보드')
await page.locator(tid('hummingCreatorNavItem')).click()
await page.waitForSelector(tid('hummingEarningsTotal'), { timeout: 15000 })
await page.screenshot({ path: SHOT('7-earnings') })
const totalText = await page.locator(tid('hummingEarningsTotal')).innerText()
console.log('   대시보드:', totalText.replace(/\n/g, ' | '))

await browser.close()
console.log('\n🎉 크리에이터 되기 E2E 완료')
