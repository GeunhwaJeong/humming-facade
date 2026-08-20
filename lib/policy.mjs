// 입력 정책 모음. 서버 핸들러에서 분리한 순수 함수들이라 체인 없이 단위 테스트된다.
// 규칙은 "가입 시점에만 강제"가 원칙이다: 로그인 검증에 쓰면 기존 유저가 잠긴다.
import crypto from 'node:crypto'

// ---- 비밀번호 정책 (계정 생성 전용) ----
export const MIN_PASSWORD_LENGTH = 8

// 유출 사전 최상위권 + 서비스 문맥 단어. 소문자 비교.
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '123123123', '987654321', '11111111',
  '00000000', '88888888', '12341234', '123454321', '1q2w3e4r', '1q2w3e4r5t',
  'qwertyui', 'qwerty123', 'qwerty1234', 'qwertyuiop', 'asdfghjkl', 'asdfasdf',
  'zxcvbnm123', 'qazwsxedc', '1qaz2wsx', 'q1w2e3r4', 'abcd1234', 'abc12345',
  'a1b2c3d4', 'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd',
  'p@ssword', 'letmein1', 'welcome1', 'welcome123', 'iloveyou', 'iloveyou1',
  'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman123',
  'trustno1', 'dragon123', 'monkey123', 'shadow123', 'master123', 'michael1',
  'jennifer', 'jordan23', 'harley123', 'hunter123', 'ranger123', 'thomas123',
  'charlie1', 'daniel123', 'jessica1', 'matthew1', 'ashley123', 'nicole123',
  'chelsea1', 'biteme123', 'access123', 'flower123', 'freedom1', 'whatever1',
  'ginger123', 'joshua123', 'maggie123', 'starwars', 'silver123', 'william1',
  'dallas123', 'yankees1', '123qweasd', 'zaq12wsx', 'password!',
  'password1!', 'admin123', 'admin1234', 'administrator', 'root1234', 'test1234',
  'testtest', 'temp1234', 'changeme', 'changeme1', 'default1', 'secret123',
  'internet', 'computer', 'samsung1', 'google123', 'facebook', 'instagram',
  'pokemon123', 'minecraft', 'fortnite', 'gundam123', 'humming1', 'humming123',
  'haneul123', 'haneul1234', 'geunhwa123', 'aaaaaaaa', 'qqqqqqqq', '11223344',
  '55555555', '66666666', '77777777', '99999999', '10203040', '19871987',
  '19901990', '20002000', '20202020', 'love1234', 'happy123', 'summer123',
  'winter123', 'spring123', 'monday123',
])

// 통과면 null, 거부면 사유 문자열 (그대로 400 메시지로 쓸 수 있는 영어 문장)
export function checkNewPassword(password) {
  const pw = String(password ?? '')
  if (pw.length < MIN_PASSWORD_LENGTH)
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  if (COMMON_PASSWORDS.has(pw.toLowerCase()))
    return 'This password is too common, choose something harder to guess'
  return null
}

// ---- 업로드 MIME 화이트리스트 ----
// 앱은 이미지(컴포저·아바타)와 비디오만 올린다 (오디오 업로드 경로 없음, 실사용 확인).
// 임의 Content-Type을 저장·반사하면 우리 origin에서 text/html 등을 호스팅하는
// 서명 URL이 만들어진다. svg는 image/*지만 스크립트 실행이 가능한 XML이라 제외.
export function isAllowedMediaMime(mime) {
  const m = String(mime ?? '').toLowerCase().split(';')[0].trim()
  if (m === 'image/svg+xml') return false
  return /^(image|video)\/[\w.+-]+$/.test(m)
}

// ---- 콘텐츠 길이 상한 ----
// 앱(humming-app)은 게시물을 300 grapheme으로 제한한다 (MAX_GRAPHEME_LENGTH).
// grapheme 1개가 여러 문자일 수 있어 서버는 보수적 문자 근사(10배)로 미러링한다:
// 정상 클라이언트는 절대 걸리지 않고, API 직접 호출로 인덱스를 부풀리는 것만 막는다.
export const MAX_POST_TEXT_CHARS = 3000
export const MAX_DISPLAY_NAME_CHARS = 64
export const MAX_DESCRIPTION_CHARS = 256
// applyWrites 한 요청이 만들 수 있는 쓰기 수 (요청당 온체인 tx 상한)
export const MAX_APPLY_WRITES = 10

// ---- 상수시간 문자열 비교 ----
// 미디어 서명 URL의 sig 비교용: !== 비교는 앞자리부터 맞춰가는 타이밍 오라클이 된다.
// timingSafeEqual은 길이가 다르면 던지므로 길이 검사를 앞에 둔다 (길이는 비밀이 아니다).
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''))
  const bb = Buffer.from(String(b ?? ''))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}
