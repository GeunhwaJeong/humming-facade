// 체인 상수 — 로컬넷 regenesis 후 재배포 시 이 파일만 갱신.
// 배포 환경은 env로 덮어쓴다 (로컬넷 기본값은 개발 편의).
export const RPC_URL = process.env.HUMMING_RPC_URL || 'http://127.0.0.1:9000'
export const FAUCET_URL = process.env.HUMMING_FAUCET_URL || 'http://127.0.0.1:9123'

// 로컬넷 여부 — 배포 가드(server.mjs)와 faucet 사용 판단의 기준
export const IS_LOCALNET = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(RPC_URL)

// humming 패키지 (10회차 배포, 2026-07-17)
export const PKG = '0xd742c71d4b5b5537319bd461439b4bfee64f464174e1bcb270251a9f826dd914'
export const FEED = '0x3f7d4739775c50d2208f7141b62033efc259f0b6d7ea6da86e5803e20f2ed6ce'
export const RULES = '0xe7df54215b20d4b749a95e302137babbe065482f474d209b477697760d657055'
export const FEE_CONFIG = '0xfdfa49a4ce62a2a74d52489028e8b3a8bf90d12af460245bdb034565a8cd235d'
// creator_prefs 공유 레지스트리 — 설정 쓰기 PTB에만 필요 (읽기는 이벤트로)
export const PREFS_REGISTRY = '0xc04b26f8a2137bc1ae20ccd70618b5eedffe169c280dc6d8782c3aa94c0641ab'
export const HANEUL_TYPE = '0x2::haneul::HANEUL'

// haneulns (온체인 네임서비스) — 가입 = 닉네임 = 지갑
export const NS_PKG = '0x5d3f16092b9acf8c6d2e1ccd1c27f16783d75a2203675d7907727ad886a9269a'
export const NS_SUB_PKG = '0x0edeeceb099db1c1561f504a102b5b7603e42804b1c930edcf202d3891b22137'
export const NS_OBJ = '0x4eb8e2c847cb7a270cc7af7f7d709f4ce54326c9351261c48b7c117a272f40ec'
export const HUM_PARENT_NFT = '0x0abe272f56cc9d257483aec2159892a3ffa49ac2efb63cddeb50d6d5d60b0024'
export const APP_WALLET = '0x7e6dc9a774eb022d809e3ab7e5d578126e98e5e351f07aee820951dd2b80c3de'
