# humming-facade

Humming의 XRPC 파사드 서버 — 무수정에 가까운 Bluesky 웹앱([humming-app](https://github.com/GeunhwaJeong/humming-app))을 Haneul 블록체인에 연결하는 번역 계층입니다.

앱은 표준 ATProto XRPC를 말하고, 체인은 Move 객체와 이벤트를 말합니다. 이 서버가 그 사이에서:

- **읽기**: 온체인 게시물(feed 모듈 레코드)을 `getTimeline`/`getAuthorFeed`/`getPostThread` 응답으로 변환
- **게이팅**: 구독(`Subscribed`)·단건구매(`PostPurchased`)·프로필 잠금(`PrefsChanged`) 온체인 상태로 열람 자격을 서버사이드에서 판정 — 비자격자 응답에서는 본문·미디어가 아예 제거됩니다. 이벤트는 커서 기반으로 제네시스부터 전량 인덱싱(`lib/indexer.mjs`)되어 인메모리 상태로 유지됩니다
- **쓰기**: 글 작성, 구독, 팁, 단건구매를 `@haneullabs/haneul` SDK Transaction으로 조립해 인프로세스 서명으로 제출 (`lib/chain.mjs`) — 서명자 지갑별로만 직렬화되고 서로 다른 지갑의 트랜잭션은 병렬 처리됩니다
- **가입 = 닉네임 = 지갑**: `createAccount` 한 번으로 지갑 생성 + `이름.hum.haneul` 온체인 서브네임 발급 ([haneulns](https://github.com/GeunhwaJeong/haneulns-contracts) leaf 레코드, 서버가 가스 대납)
- **미디어**: 파일 실물은 오프체인(`media/`), 체인에는 CID 포인터만. 자격자에게만 HMAC 서명 URL 발급

## 실행

로컬넷·컨트랙트 배포가 선행되어야 합니다. `lib/config.mjs`(패키지·공유객체 주소)를 배포값으로 갱신한 뒤:

```bash
npm install
node server.mjs   # http://localhost:3025
```

로컬넷을 `--force-regenesis`로 새로 만들었다면 `accounts.json`(가입 계정)과 `wallet-keys.json`(지갑 키 저장소)을 삭제하고 시작하세요 — 온체인 원본이 사라진 낡은 값입니다. 시드 계정 키는 부팅 시 CLI 키스토어에서 자동 임포트됩니다.

## E2E

`e2e-*.mjs`는 Playwright로 실제 웹앱을 구동해 검증한 시나리오들입니다 (가입, 구독 페이월, 전면 잠금 프로필, 미디어 게이팅, 단건구매). `e2e-*.png`가 각 시나리오의 실행 증적입니다.

## 상태

로컬넷 데모 단계입니다. 계정 키를 서버가 보관하는 수탁 구조(`wallet-keys.json`)이며, zkLogin/패스키 기반 비수탁 전환이 로드맵에 있습니다. `accounts.json`(가입 계정), `wallet-keys.json`(지갑 비밀키), `media/`(업로드 실물)는 런타임 데이터라 커밋되지 않습니다.
