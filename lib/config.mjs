// 체인 상수 — 네트워크 선택은 HUMMING_NETWORK(기본 localnet, 'mainnet'으로 전환).
// 로컬넷 regenesis 후에는 LOCALNET 블록만 갱신하면 된다. env로 개별 덮어쓰기 가능.
export const NETWORK = process.env.HUMMING_NETWORK === 'mainnet' ? 'mainnet' : 'localnet'

export const RPC_URL =
  process.env.HUMMING_RPC_URL ||
  (NETWORK === 'mainnet' ? 'http://158.69.54.239:9000' : 'http://127.0.0.1:9000')
export const FAUCET_URL = process.env.HUMMING_FAUCET_URL || 'http://127.0.0.1:9123'

// 로컬넷 posture 여부 — 배포 가드(server.mjs)와 faucet 사용 판단의 기준.
// HUMMING_NETWORK=mainnet 또는 HUMMING_ENV=production이면 URL이 localhost여도
// 프로덕션 posture 강제 (시드 계정·완화된 리밋·faucet 등 로컬넷 전제 전부 해제).
export const IS_LOCALNET =
  NETWORK !== 'mainnet' &&
  process.env.HUMMING_ENV !== 'production' &&
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(RPC_URL)

// 메인넷 체인 식별자 — URL만으로는 어느 체인인지 보장할 수 없으므로 부팅 시
// 실체인과 양방향 대조한다 (server.mjs 가드: 로컬넷 posture인데 메인넷이면 거부,
// NETWORK=mainnet인데 메인넷이 아니어도 거부)
export const MAINNET_CHAIN_ID = 'a0053d9e'

// 로컬넷 11회차 배포 (2026-07-18) — regenesis 시 이 블록만 갱신
const LOCALNET = {
  PKG: '0xc1af7d1666a95e8296d2b1429a4911d757ef8c7722691a98f9f14689bac33957',
  FEED: '0x0e951c60802b3b2a06ee8c4dc1e6e61db6e57dec5d634cf2a1a29dc777158ebf',
  RULES: '0x57a1f6bb3b38a9beb58270dd673cfcd4a07bcc131da65383bcb36fb48075992b',
  FEE_CONFIG: '0xd2130f72e5e264a8a453bec7aadf80c0b54ce0cfc317dddc8546a158a7d57d80',
  PREFS_REGISTRY: '0x66d27b7824a81f67a2c45eed59114d9d85101bf368801b8f6599b608187cdad3',
  NS_PKG: '0x83b4ab9ceeae9463799fa695127597853f6fedfaada96159e26ef7364eb95fef',
  NS_SUB_PKG: '0xf8b53f0688cfae48b466b36ba70530d99f91c68f40624cac2f316c834d84fb47',
  NS_OBJ: '0x3e8dbf534ff92fe4e7be7caa318f110e13da11af268205dedcffcca95a5e65f4',
  HUM_PARENT_NFT: '0x8f2dd315712337fb22249cec9b90cefc8ec5133af2046a03e7622d182865fb8d',
  APP_WALLET: '0x7e6dc9a774eb022d809e3ab7e5d578126e98e5e351f07aee820951dd2b80c3de',
  // 로컬넷 denylist 테이블은 비어 있어 조회 생략 (개발 편의)
  DENY_RESERVED_TABLE: null,
  DENY_BLOCKED_TABLE: null,
}

// 메인넷 배포 (humming 2026-07-18 publish BtFFMEhT.., haneulns 2026-07-13)
const MAINNET = {
  PKG: '0x0a5ad6be4dfe8d86fcb675442fbcce622085b68e4a8abd81a897ef725fa4a348',
  FEED: '0xb7e76913c0600440e860a143c6ec5604186d5866a9e693aab2a4faa618d3e13a',
  RULES: '0x76487f01752f41369dfed388cf48a55e0f0c1deb6360010533a3c42f7fcfeace',
  FEE_CONFIG: '0xa95599b9e52583fa2c532000a382c5004da7a9d40665313273c2346003d06511',
  PREFS_REGISTRY: '0xe46f78a01e1e5100bfe489aac7a4fefdca34b19b1f24160450715f2ab476abeb',
  NS_PKG: '0x047dfbd82298ec1c2c70b5743a8c4a00614ff864a580069c635f2dad3a7c76fa',
  NS_SUB_PKG: '0x3ebb0b633d4d56c2eaad2b1849fcc8cddbab832414e91b4159dd4a57c4a720d4',
  NS_OBJ: '0x186ad0dd1d4d4bc84564b3c039a0d432ab4d4af851e07cc84f083cc5e850f6d0',
  // hum.haneul 등록 NFT — ns-ops에서 humming-app(핫월렛)으로 이양됨 (가입 leaf 서명용)
  HUM_PARENT_NFT: '0x38bc24d9774167c3074bfedf4407429cd1a0bb6e9a3f0317603ce111c5fadb76',
  APP_WALLET: '0xa4758e18038a24efbadb72abd29f469c0b4761e12357bf9449154fe0fae7c96e',
  // 온체인 new_leaf는 denylist를 강제하지 않음(NFT 소유자 발급 경로) — 파사드가 집행 지점
  DENY_RESERVED_TABLE: '0x6da7700c0850043b72792946d35d0a7acc160ce68a61460c3998546a5ed6ef54',
  DENY_BLOCKED_TABLE: '0x34894b0ec10de92033cf1fb9217f1d73aac6c026986b681679aafcf40bebe3bd',
}

const A = NETWORK === 'mainnet' ? MAINNET : LOCALNET
export const PKG = A.PKG
export const FEED = A.FEED
export const RULES = A.RULES
export const FEE_CONFIG = A.FEE_CONFIG
export const PREFS_REGISTRY = A.PREFS_REGISTRY
export const NS_PKG = A.NS_PKG
export const NS_SUB_PKG = A.NS_SUB_PKG
export const NS_OBJ = A.NS_OBJ
export const HUM_PARENT_NFT = A.HUM_PARENT_NFT
export const APP_WALLET = A.APP_WALLET
export const DENY_RESERVED_TABLE = A.DENY_RESERVED_TABLE
export const DENY_BLOCKED_TABLE = A.DENY_BLOCKED_TABLE
export const HANEUL_TYPE = '0x2::haneul::HANEUL'
