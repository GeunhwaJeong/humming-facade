// E2E: 가입 = 닉네임 = 지갑 — 앱 가입 화면(닉네임+비밀번호 단일 스텝) → createAccount
// → 온체인 leaf 이름 + 자동 생성 지갑 검증.
// Run: node e2e-signup.mjs
import { chromium } from 'playwright'

const APP = process.env.APP_URL || 'http://localhost:19006'
const RPC = 'http://127.0.0.1:9000'
const NS = '0x185c3a7352aca4b3e9eca1806c0068482bba74796f2ccbf4ac996b4da8f0d447'
const REGISTRY_TABLE = '0x0b69f05f2895a743889f057247686ea19197747454b942ca27ce8a96c6a9f1c6'
const NAME = process.env.SIGNUP_NAME || 'sora'
const PASSWORD = 'humming123'
const SHOT = n => `/Users/jeong-gh/humming-facade/e2e-signup-${n}.png`
const tid = id => `[data-testid="${id}"]`

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()).result
}

async function chainRecord(name) {
  const res = await rpc('haneulx_getDynamicFieldObject', [
    REGISTRY_TABLE,
    { type: `${NS}::domain::Domain`, value: { labels: ['haneul', 'hum', name] } },
  ])
  const f = res?.data?.content?.fields?.value?.fields
  return f ? { target: f.target_address } : null
}

console.log(`0) 사전 상태: ${NAME}.hum.haneul 온체인 레코드 =`, await chainRecord(NAME))

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
let facadeHits = 0
page.on('request', r => {
  if (r.url().includes('localhost:3025')) facadeHits++
})
page.on('console', m => {
  if (m.type() === 'error') console.log('🔴 browser:', m.text().slice(0, 200))
})

console.log('1) 앱 접속:', APP)
await page.goto(APP, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForTimeout(5000)

console.log('2) 계정 만들기 진입')
// 랜딩 모달([role=dialog]) 안의 가입 버튼이 우선, 없으면 스플래시/NavSignupCard
const dialog = page.locator('[role="dialog"]').first()
if (await dialog.isVisible().catch(() => false)) {
  await dialog
    .getByRole('button', { name: /create account|계정 생성|가입/i })
    .first()
    .click({ timeout: 30000 })
} else {
  const splashBtn = page.locator(tid('createAccountButton')).first()
  if (await splashBtn.isVisible().catch(() => false)) {
    await splashBtn.click()
  } else {
    await page
      .getByRole('button', { name: /create account|계정 생성|가입/i })
      .first()
      .click({ timeout: 30000 })
  }
}

console.log('3) 닉네임+비밀번호 단일 화면 (가입=닉네임=지갑)')
await page.waitForSelector(tid('handleInput'), { timeout: 30000 })
await page.locator(tid('handleInput')).fill(NAME)
await page.waitForTimeout(2000) // 가용성 검사 debounce
const availableCheck = await page
  .locator(tid('handleAvailableCheck'))
  .isVisible()
  .catch(() => false)
console.log('   가용성 체크 표시:', availableCheck ? '✅ available' : '⚠️ 미표시')
await page.locator(tid('passwordInput')).fill(PASSWORD)
await page.screenshot({ path: SHOT('1-nickname-step') })
await page.locator(tid('nextBtn')).click()

console.log('4) 가입 제출 → 온보딩 통과 → 홈 진입 (지갑 생성 + faucet + leaf 발급)')
await page.waitForTimeout(20000)
await page.screenshot({ path: SHOT('2-after-submit') })

// 가입 직후 표준 온보딩(아바타/관심사 등) — "계속" 계열 버튼을 눌러 통과
const homeSel = `${tid('homeScreenFeedTabs')}, ${tid('viewHeaderDrawerBtn')}, ${tid('bottomBarProfileBtn')}`
let loggedIn = false
for (let i = 0; i < 10; i++) {
  loggedIn = await page.locator(homeSel).first().isVisible().catch(() => false)
  if (loggedIn) break
  const nextBtn = page
    .locator(
      `${tid('onboardingContinue')}, ${tid('onboardingFinish')}, [aria-label="Skip to next step"], [aria-label="다음 단계로 건너뛰기"]`,
    )
    .first()
  if (await nextBtn.isVisible().catch(() => false)) {
    await nextBtn.click().catch(() => {})
    await page.waitForTimeout(2500)
  } else {
    await page.waitForTimeout(2500)
  }
}
await page.screenshot({ path: SHOT('3-home') })
console.log('   앱 로그인 상태:', loggedIn ? '✅ 홈 진입' : '⚠️ 홈 미확인 (스크린샷 확인)')
console.log('   파사드 요청 수:', facadeHits)

console.log('5) 온체인 검증')
const rec = await chainRecord(NAME)
if (!rec) throw new Error('온체인 레코드가 없음 — 가입 실패')
console.log(`   ${NAME}.hum.haneul → ${rec.target}`)
const bal = await rpc('haneulx_getBalance', [rec.target, '0x2::haneul::HANEUL'])
console.log(`   지갑 잔고: ${Number(bal.totalBalance) / 1e9} HANEUL`)

console.log('6) 재로그인 + 신규 지갑으로 구독 실증 (가입 지갑 = 즉시 결제 주체)')
const sess = await (await fetch('http://localhost:3025/xrpc/com.atproto.server.createSession', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: `${NAME}.hum.haneul`, password: PASSWORD }),
})).json()
console.log('   재로그인:', sess.did === `did:web:${NAME}.hum.haneul` ? '✅' : JSON.stringify(sess))

const sub = await (await fetch('http://localhost:3025/xrpc/app.humming.monetization.subscribe', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${sess.accessJwt}`,
  },
  body: JSON.stringify({ creator: 'bob.hum.haneul' }),
})).json()
console.log('   bob 구독:', sub.digest ? `✅ tx ${sub.digest.slice(0, 12)}…` : JSON.stringify(sub))

await browser.close()
console.log('\n🎉 가입=닉네임=지갑 E2E 완료')
