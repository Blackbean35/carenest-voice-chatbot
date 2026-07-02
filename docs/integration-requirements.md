# CareNest 음성 문진 — 연동 앱 필수 정보 요약

기준일: 2026-07-03
대상: `voice-B-realtime-rag-tools`를 하나의 기능으로 붙이려는 앱/백엔드 개발자

이 문서는 **"내 앱이 무엇을 준비하고 무엇을 넘겨야 하는가"**만 빠르게 정리한 체크리스트입니다.
이벤트 스키마·연동 방식·운영 보강 등 상세 계약은 [app-integration-guide.md](./app-integration-guide.md)를 보세요.

---

## 1. 발급받아야 할 키 (가장 중요)

| 키 | 어디서 | 어디에 쓰나 | 노출 범위 | 없으면 |
|---|---|---|---|---|
| `OPENAI_API_KEY` | OpenAI | LLM 스트리밍·임베딩 | **서버 전용(비밀)** | `/ask` 자체가 동작 안 함 |
| `KAKAO_REST_API_KEY` | 카카오 콘솔 → 앱 키 → **REST API 키** | 서버가 병원 좌표 검색(Local API) | **서버 전용(비밀)** | 병원 검색만 비활성(문진은 정상) |
| `KAKAO_JS_API_KEY` | 카카오 콘솔 → 앱 키 → **JavaScript 키** | 브라우저가 카카오 **지도** SDK 로드 | **클라이언트 노출(공개 식별자)** | 지도가 Leaflet/OSM으로 대체됨 |

> ⚠️ **REST 키와 JavaScript 키는 서로 다른 키입니다.**
> 같은 앱 안에서도 별개 값이며 바꿔 넣으면 안 됩니다.
> - 지도가 카카오맵이 아니라 OpenStreetMap으로 나온다면 → 먼저 `KAKAO_JS_API_KEY`가 채워졌는지, **서버를 재시작했는지** 확인하세요. (`.env`는 부팅 시 1회만 로드됩니다.)
> - JS 키까지 넣었는데도 대체 지도면 → 그때가 진짜 도메인 문제입니다. 카카오 콘솔의 **JavaScript SDK 도메인**에 실제 접속 origin(scheme+host+port 완전 일치)을 등록하세요. `localhost`와 `127.0.0.1`은 서로 다른 origin입니다.

### 설정 상태 확인

```
GET /health
→ { "kakaoConfigured": true, "kakaoMapConfigured": true, ... }
```

- `kakaoConfigured` = REST 키 유무
- `kakaoMapConfigured` = JS 키 유무

```
GET /client-config
→ { "kakaoJsKey": "..." }   // null 이면 브라우저 지도가 절대 안 뜸
```

---

## 2. 한 턴마다 앱이 넘겨야 할 값

```
GET /ask?q={질문}&sid={세션ID}&childId={아이ID}&lat={위도}&lng={경도}
Accept: text/event-stream
```

| 값 | 필수 | 앱이 준비하는 방법 |
|---|:--:|---|
| `q` | ✅ | **STT가 확정한(final) 한국어 텍스트.** 오디오가 아니라 텍스트를 보냅니다. interim 전사는 화면 표시용으로만. |
| `sid` | 권장 | 상담 시작 시 `crypto.randomUUID()` 등으로 생성해 한 상담 내내 재사용. **생략하면 모든 요청이 `default` 세션을 공유하므로 실서비스에선 필수.** |
| `childId` | ⬜ | 프로필 조회/갱신 대상 아이 ID. 없으면 프로필 도구는 건너뜀. |
| `lat`/`lng` | ⬜ | 위치 권한 허용 시 좌표. **둘 다 함께** 보냄. 없으면 병원 검색만 불가. |

---

## 3. 앱이 직접 구현해야 하는 것 (서버가 안 해주는 부분)

서버로 가는 것은 **텍스트뿐**입니다. 음성 입출력과 화면은 앱 몫입니다.

- **STT (음성 → 텍스트)**: Web은 Web Speech API, RN/Expo는 STT 모듈, Native는 iOS Speech / Android SpeechRecognizer. 확정 텍스트만 `q`로 전송.
- **TTS (텍스트 → 음성)**: `sentence` 이벤트를 순서대로 읽음. 새 발화가 시작되면 TTS 큐와 현재 스트림을 즉시 취소(끼어들기).
- **권한 UX**: 마이크·위치 목적을 각각 고지하고, 동의한 항목만 OS 권한 요청. 위치 거부를 전체 사용 거부로 취급하지 않기.
- **지도(선택)**: 앱 자체 지도가 있으면 카카오 SDK 불필요 — `tool.hospitals`의 좌표로 앱 지도에 마커만 찍으면 됨.

---

## 4. 앱이 받는 것 (SSE 이벤트)

한 턴은 대략 `meta → delta… → sentence… → tool(0+) → done` 순서로 옵니다. **이벤트 이름으로 처리하고 순서를 가정하지 마세요.**

| 이벤트 | 용도 | 앱 처리 |
|---|---|---|
| `meta` | 응급 여부·RAG 출처 선통보 | `emergency:true`면 119/응급실 행동을 **가장 먼저** 표시 |
| `delta` | 토큰 단위 텍스트 조각 | 자막 실시간 이어붙이기 (TTS 단위 아님) |
| `sentence` | 완성 문장 | TTS 큐에 투입 |
| `tool` | 도구 실행 상태 | `find_nearby_hospitals`면 `hospitals[]`로 지도·카드 |
| `done` | 최종 결과 | `answer`, `path`, `sources`, `toolTrace`, `timings`. **`done.error`를 반드시 확인** (오류도 HTTP 200 안에 담김) |

---

## 5. 최소 준비 체크리스트

- [ ] `OPENAI_API_KEY` 발급 → 서버 `.env`에만 저장
- [ ] 카카오 **REST API 키** → `KAKAO_REST_API_KEY` (서버 전용)
- [ ] 카카오 **JavaScript 키** → `KAKAO_JS_API_KEY` (지도용, 콘솔에 접속 도메인 등록)
- [ ] `.env` 채운 뒤 **서버 재시작**, `/health`로 `kakaoMapConfigured: true` 확인
- [ ] 상담 세션마다 고유 `sid` 생성·재사용
- [ ] STT 확정 텍스트만 `q`로 전송, interim은 화면용
- [ ] `sentence` 기반 TTS + 끼어들기 시 스트림/TTS 취소
- [ ] `meta.emergency`를 다른 UI보다 우선 표시
- [ ] `done.error` 처리 및 SSE 조기 종료 대비
- [ ] (실서비스) 인증·권한·CORS·rate limit·로그 마스킹은 앞단 BFF에서 — [가이드 §14](./app-integration-guide.md) 참고

---

## 6. 자주 나오는 증상 → 원인

| 증상 | 가장 흔한 원인 |
|---|---|
| 지도가 카카오맵이 아니라 OSM으로 뜸 | `KAKAO_JS_API_KEY` 미설정 또는 서버 미재시작 (`/client-config`의 `kakaoJsKey`가 `null`) |
| JS 키 넣었는데도 대체 지도 | JavaScript SDK 도메인 미등록, 또는 `127.0.0.1`↔`localhost` origin 불일치 |
| 병원이 하나도 안 나옴 | 위치 미전송(`lat`/`lng` 누락), 반경/검색어 부적합, `KAKAO_REST_API_KEY` 문제 |
| `/ask`가 즉시 오류 | `OPENAI_API_KEY` 없음 또는 `OPENAI_CHAT_MODEL` 값이 유효하지 않은 모델 ID |
| 이전 답을 자꾸 다시 물음 | `sid`를 매 턴 새로 만들거나 생략함 (세션 히스토리 유실) |

---

관련 구현 파일: 서버 [src/server.ts](../src/server.ts) · 파이프라인 [src/pipeline.ts](../src/pipeline.ts) · 도구 [src/tools.ts](../src/tools.ts) · 병원 검색 [src/hospitals.ts](../src/hospitals.ts)
