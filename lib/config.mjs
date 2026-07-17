// 체인 상수 — 로컬넷 regenesis 후 재배포 시 이 파일만 갱신.
// 배포 환경은 env로 덮어쓴다 (로컬넷 기본값은 개발 편의).
export const RPC_URL = process.env.HUMMING_RPC_URL || 'http://127.0.0.1:9000'
export const FAUCET_URL = process.env.HUMMING_FAUCET_URL || 'http://127.0.0.1:9123'

// 로컬넷 여부 — 배포 가드(server.mjs)와 faucet 사용 판단의 기준.
// HUMMING_ENV=production이면 URL이 localhost여도 프로덕션 posture를 강제한다
// (시드 계정·완화된 리밋·faucet 등 로컬넷 전제 전부 해제).
export const IS_LOCALNET =
  process.env.HUMMING_ENV !== 'production' &&
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(RPC_URL)

// 메인넷 체인 식별자 — URL만으로는 로컬넷을 보장할 수 없으므로(메인넷 풀노드와
// 같은 박스면 127.0.0.1이 곧 메인넷) 부팅 시 실체인과 대조한다 (server.mjs 가드)
export const MAINNET_CHAIN_ID = 'a0053d9e'

// humming 패키지 (11회차 배포, 2026-07-18)
export const PKG = '0xc1af7d1666a95e8296d2b1429a4911d757ef8c7722691a98f9f14689bac33957'
export const FEED = '0x0e951c60802b3b2a06ee8c4dc1e6e61db6e57dec5d634cf2a1a29dc777158ebf'
export const RULES = '0x57a1f6bb3b38a9beb58270dd673cfcd4a07bcc131da65383bcb36fb48075992b'
export const FEE_CONFIG = '0xd2130f72e5e264a8a453bec7aadf80c0b54ce0cfc317dddc8546a158a7d57d80'
// creator_prefs 공유 레지스트리 — 설정 쓰기 PTB에만 필요 (읽기는 이벤트로)
export const PREFS_REGISTRY = '0x66d27b7824a81f67a2c45eed59114d9d85101bf368801b8f6599b608187cdad3'
export const HANEUL_TYPE = '0x2::haneul::HANEUL'

// haneulns (온체인 네임서비스) — 가입 = 닉네임 = 지갑
export const NS_PKG = '0x83b4ab9ceeae9463799fa695127597853f6fedfaada96159e26ef7364eb95fef'
export const NS_SUB_PKG = '0xf8b53f0688cfae48b466b36ba70530d99f91c68f40624cac2f316c834d84fb47'
export const NS_OBJ = '0x3e8dbf534ff92fe4e7be7caa318f110e13da11af268205dedcffcca95a5e65f4'
export const HUM_PARENT_NFT = '0x8f2dd315712337fb22249cec9b90cefc8ec5133af2046a03e7622d182865fb8d'
export const APP_WALLET = '0x7e6dc9a774eb022d809e3ab7e5d578126e98e5e351f07aee820951dd2b80c3de'
