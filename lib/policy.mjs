// 입력 정책 모음. 서버 핸들러에서 분리한 순수 함수들이라 체인 없이 단위 테스트된다.
// 규칙은 "가입 시점에만 강제"가 원칙이다: 로그인 검증에 쓰면 기존 유저가 잠긴다.

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
