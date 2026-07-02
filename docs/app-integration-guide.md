# CareNest 음성 챗봇 외부 앱 연동 가이드

기준일: 2026-07-03
대상: 다른 Web, React Native/Expo 또는 Native 앱에서 `voice-B-realtime-rag-tools`를 하나의 기능으로 사용하는 개발자

## 1. 먼저 결정할 연동 방식

| 방식 | 적합한 경우 | 장점 | 주의점 |
|---|---|---|---|
| WebView/iframe 임베드 | 기존 챗봇 화면을 그대로 빠르게 넣을 때 | 동의창, STT/TTS, 지도까지 재사용 | 앱 디자인·상태와의 결합이 약함 |
| SSE API 연동 | 앱 고유 UI와 사용자 계정을 사용할 때 | 화면·음성·지도 UX를 앱이 통제 | 앱에서 STT, TTS, 위치, 지도 구현 필요 |
| Node 모듈 직접 호출 | 동일한 Node.js 백엔드에 합칠 때 | HTTP 경계 없이 `streamTurn` 재사용 | 세션·배포·장애 격리가 어려워질 수 있음 |

권장 구조는 **앱 UI → 앱 백엔드/BFF → CareNest 서버**입니다. 현재 API는 해커톤 프로토타입 계약이므로, 실제 서비스에서는 앱 백엔드가 인증·권한·감사·rate limit을 담당하고 CareNest를 내부 서비스로 호출하는 편이 안전합니다.

## 2. 전체 데이터 흐름

```text
사용자 동의
  ├─ 마이크 권한 → 앱 STT → 확정된 한국어 텍스트
  └─ 위치 권한   → 위도(lat), 경도(lng)
                         │
                         ▼
앱/BFF ── /ask SSE ──> red-flag 안전 규칙
                         → RAG + 사용자 프로필
                         → OpenAI streaming + function tools
                         → SSE: meta / delta / sentence / tool / done
                         │
                         ▼
앱 화면
  ├─ delta: 답변 텍스트 실시간 표시
  ├─ sentence: 문장 단위 TTS
  ├─ tool.hospitals: 지도 마커와 병원 카드
  └─ done: 최종 결과 저장 및 턴 종료
```

중요: 현재 서버로 전송되는 것은 오디오가 아니라 **STT가 확정한 텍스트**입니다. 브라우저 데모는 Web Speech API로 STT/TTS를 처리합니다. 다른 앱은 플랫폼 STT/TTS를 사용하면 됩니다.

## 3. 서버 실행과 필수 환경 변수

```powershell
cd carenest-voice-chatbot
npm.cmd install
npm.cmd run typecheck
npm.cmd run test:offline
npm.cmd run serve
```

기본 주소는 `http://localhost:5180`입니다.

```dotenv
OPENAI_API_KEY=...
OPENAI_CHAT_MODEL=gpt-5.4-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
KAKAO_REST_API_KEY=...
KAKAO_JS_API_KEY=...
PORT=5180
```

- `OPENAI_API_KEY`, `KAKAO_REST_API_KEY`는 서버에만 둡니다.
- `KAKAO_JS_API_KEY`는 지도 SDK 때문에 클라이언트에 노출되는 공개 식별자입니다. Kakao Developers에서 실제 웹 origin만 허용해야 합니다.
- Kakao JavaScript SDK 도메인에는 scheme, host, port가 모두 같은 origin을 등록합니다. 예: `http://localhost:5180`, `https://chat.example.com`.

서버가 준비되었는지 먼저 확인합니다.

```http
GET /health
```

```json
{
  "ok": true,
  "model": "gpt-5.4-mini",
  "ragChunks": 12,
  "kakaoConfigured": true,
  "kakaoMapConfigured": true
}
```

## 4. 현재 HTTP API

| Method | Path | 용도 |
|---|---|---|
| `GET` | `/` | 완성된 브라우저 챗봇 UI |
| `GET` | `/health` | 서버·RAG·Kakao 설정 상태 확인 |
| `GET` | `/client-config` | 브라우저용 Kakao JavaScript key 조회 |
| `GET` | `/ask` | 한 턴을 처리하고 SSE 이벤트 스트리밍 |
| `GET` | `/reset?sid=...` | 해당 대화 세션의 서버 메모리 삭제 |

현재 서버에는 CORS 헤더가 없습니다. 서로 다른 origin에서 직접 호출하지 말고 다음 중 하나를 사용합니다.

1. 앱과 챗봇을 같은 origin의 reverse proxy 아래에 둡니다.
2. 앱 백엔드/BFF가 CareNest SSE를 중계합니다.
3. 개발 중에만 명시적인 allowlist CORS를 추가합니다.

## 5. 한 턴 요청 계약

```http
GET /ask?q={question}&sid={sessionId}&childId={childId}&lat={latitude}&lng={longitude}
Accept: text/event-stream
```

| Query | 필수 | 설명 |
|---|---:|---|
| `q` | 예 | STT 최종 전사 또는 사용자가 입력한 문장 |
| `sid` | 권장 | 상담 세션 ID. 한 상담 동안 동일한 값을 재사용 |
| `childId` | 아니오 | 조회·갱신할 아이 프로필 ID |
| `lat` | 아니오 | 위도, `-90..90` |
| `lng` | 아니오 | 경도, `-180..180` |

`lat`, `lng`는 함께 전달합니다. 위치를 보내지 않아도 문진은 가능하지만 `find_nearby_hospitals`는 실행할 수 없습니다.

세션 ID는 상담 시작 시 UUID로 만들고 사용자 ID와 분리합니다. `sid`를 생략하면 모든 요청이 `default` 세션을 공유하므로 실제 연동에서는 생략하면 안 됩니다.

```ts
const sid = crypto.randomUUID();
const params = new URLSearchParams({
  q: "아이 체온이 39도예요",
  sid,
  childId: "child-001",
  lat: "37.5665",
  lng: "126.9780",
});
const streamUrl = `${CARE_NEST_URL}/ask?${params}`;
```

### 운영 환경에서 변경해야 할 점

현재 `GET /ask`는 질문과 위치를 URL query에 넣습니다. 의료 내용이 browser history, proxy access log, APM에 남을 수 있으므로 프로토타입 외 환경에서는 그대로 공개하지 마십시오.

권장 앱 공개 계약은 다음 중 하나입니다.

- `POST /api/voice/v1/turn` + fetch response streaming
- 인증된 WebSocket의 `turn.start` 메시지

앱 백엔드가 body의 값을 내부 CareNest 호출로 변환하고, 내부 access log에서도 query string을 마스킹해야 합니다.

## 6. SSE 이벤트 계약

모든 이벤트는 다음 형식입니다.

```text
event: delta
data: {"text":"체온을 "}

```

한 턴의 일반적인 순서는 아래와 같습니다.

```text
meta → delta 여러 개 → sentence 여러 개 → tool 0개 이상 → done
```

도구 호출 때문에 `tool`과 답변 조각의 순서는 달라질 수 있습니다. 이벤트 이름으로 처리하고 고정 순서에 의존하지 마십시오.

### `meta`

RAG 근거와 응급 여부를 가장 먼저 알립니다.

```json
{
  "emergency": false,
  "sources": ["질병관리청 영유아 발열 안내"]
}
```

응급 규칙에 걸리면 LLM 응답을 기다리지 않고 다음처럼 전달될 수 있습니다.

```json
{
  "emergency": true,
  "action": "119",
  "sources": ["CareNest red-flag 안전규칙"]
}
```

### `delta`

화면에 즉시 이어 붙일 텍스트 조각입니다.

```json
{ "text": "체온을 측정해 보셨나요?" }
```

`delta`는 토큰 경계에 가까운 작은 조각이므로 TTS 단위로 사용하지 않습니다.

### `sentence`

TTS 큐에 넣을 수 있는 완성 문장입니다.

```json
{ "text": "체온을 측정해 보셨나요?" }
```

응답 중 사용자가 끼어들면 현재 `EventSource`/stream을 닫고 TTS를 중단한 뒤 새 STT를 시작합니다.

### `tool`

RAG, 프로필 또는 병원 검색 도구 실행 상태입니다.

```json
{
  "name": "update_user_profile",
  "summary": "프로필 갱신: weightKg, allergies"
}
```

병원 검색이면 `hospitals`가 추가됩니다.

```json
{
  "name": "find_nearby_hospitals",
  "summary": "근처 병원 3곳 검색",
  "hospitals": [
    {
      "placeId": "123456",
      "name": "예시소아청소년과의원",
      "address": "서울특별시 ...",
      "lat": 37.5667,
      "lng": 126.9784,
      "phone": "02-000-0000",
      "distanceM": 420,
      "placeUrl": "https://place.map.kakao.com/123456"
    }
  ]
}
```

병원 결과는 현재 최대 5개이며 서버 프롬프트는 음성으로 최대 3곳만 간단히 안내하도록 구성되어 있습니다. 지도는 `lat`, `lng`로 마커를 만들고 카드에는 이름, 거리, 주소, 전화, `placeUrl`을 표시합니다.

### `done`

정상 종료의 최종 결과입니다.

```json
{
  "answer": "체온을 실제로 측정해 보셨나요?",
  "emergency": false,
  "path": "stream",
  "sources": ["질병관리청 영유아 발열 안내"],
  "toolTrace": ["search_medical_knowledge"],
  "hospitals": [],
  "timings": {
    "context": 34.2,
    "firstToken": 515.4,
    "firstSentence": 702.1,
    "done": 911.8
  }
}
```

`path`는 `redflag` 또는 `stream`입니다. `action`은 존재할 때 `119`, `ER`, `clinic`, `self_observe` 중 하나로 취급하는 것이 좋습니다. 오류도 HTTP 200 SSE 안의 `done`으로 전달될 수 있습니다.

```json
{ "error": "empty_question" }
```

따라서 HTTP status만 확인하지 말고 반드시 `done.error`를 처리합니다.

## 7. Web/TypeScript 연동 예제

```ts
type Hospital = {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  phone?: string;
  distanceM?: number;
  placeUrl?: string;
};

type TurnHandlers = {
  onText: (fullText: string) => void;
  onSentence: (sentence: string) => void;
  onHospitals: (hospitals: Hospital[]) => void;
  onEmergency: (action?: string) => void;
  onDone: (result: unknown) => void;
  onError: (error: Error) => void;
};

export function sendTurn(
  baseUrl: string,
  input: {
    question: string;
    sid: string;
    childId?: string;
    location?: { lat: number; lng: number };
  },
  handlers: TurnHandlers,
) {
  const params = new URLSearchParams({ q: input.question, sid: input.sid });
  if (input.childId) params.set("childId", input.childId);
  if (input.location) {
    params.set("lat", String(input.location.lat));
    params.set("lng", String(input.location.lng));
  }

  const source = new EventSource(`${baseUrl}/ask?${params}`);
  let fullText = "";
  let completed = false;

  source.addEventListener("meta", (event) => {
    const meta = JSON.parse((event as MessageEvent).data);
    if (meta.emergency) handlers.onEmergency(meta.action);
  });

  source.addEventListener("delta", (event) => {
    const { text } = JSON.parse((event as MessageEvent).data);
    fullText += text;
    handlers.onText(fullText);
  });

  source.addEventListener("sentence", (event) => {
    const { text } = JSON.parse((event as MessageEvent).data);
    handlers.onSentence(text);
  });

  source.addEventListener("tool", (event) => {
    const tool = JSON.parse((event as MessageEvent).data);
    if (tool.name === "find_nearby_hospitals" && tool.hospitals) {
      handlers.onHospitals(tool.hospitals);
    }
  });

  source.addEventListener("done", (event) => {
    completed = true;
    const result = JSON.parse((event as MessageEvent).data);
    source.close();
    if (result.error) handlers.onError(new Error(result.error));
    else handlers.onDone(result);
  });

  source.onerror = () => {
    source.close();
    if (!completed) handlers.onError(new Error("챗봇 연결이 종료되었습니다."));
  };

  // 끼어들기 또는 화면 이탈 시 호출합니다.
  return () => source.close();
}
```

`EventSource`는 네트워크 오류 시 자동 재연결하려고 합니다. 이 API는 요청 하나가 대화 한 턴이므로 오류 시 동일 질문이 중복 처리되지 않게 `source.close()` 후 사용자에게 재시도를 선택하게 하는 편이 안전합니다.

React Native에는 브라우저의 `EventSource`가 기본 제공되지 않는 경우가 많습니다. custom UI로 연동할 때는 검증된 SSE client 또는 `fetch` response streaming을 사용하고, 수신 버퍼를 `event:`/`data:` 블록 단위로 파싱합니다. 인증 header가 필요하다면 브라우저 `EventSource` 대신 BFF의 same-origin cookie 또는 header를 지원하는 streaming client를 사용합니다.

## 8. 음성 입출력 연결

### 입력

1. 챗봇 화면 진입 직후 앱 자체 설명 화면에서 마이크 사용 목적과 위치 사용 목적을 각각 알립니다.
2. 사용자가 동의한 항목에 대해서만 OS 권한 요청을 호출합니다.
3. STT interim transcript는 화면에만 표시합니다.
4. STT final transcript만 `/ask`의 `q`로 전송합니다.
5. 빈 문자열, 지나치게 짧은 잡음, 동일 전사의 중복 전송을 차단합니다.

위치 거부는 챗봇 전체 사용 거부로 취급하지 않습니다. 문진은 계속하고 병원 검색 시 위치를 다시 요청하거나 사용자가 지역을 직접 입력할 수 있게 합니다.

### 출력

1. `delta`로 자막을 실시간 갱신합니다.
2. `sentence`를 순서대로 TTS 큐에 넣습니다.
3. 새 사용자 발화가 시작되면 TTS 큐와 현재 SSE를 취소합니다.
4. `meta.emergency === true`이면 일반 카드보다 119/응급실 행동을 가장 먼저 표시합니다.

Web에서는 Web Speech API, React Native/Expo에서는 사용하는 STT 모듈과 `expo-speech`, Native 앱에서는 iOS Speech/AVSpeechSynthesizer 또는 Android SpeechRecognizer/TextToSpeech로 연결할 수 있습니다. OS·브라우저마다 한국어 음성 품질과 권한 정책이 다르므로 실제 기기 검증이 필요합니다.

## 9. 지도와 병원 카드 연결

앱이 자체 지도 화면을 가진다면 Kakao JavaScript SDK에 의존할 필요가 없습니다. `tool.hospitals`의 좌표를 사용해 앱 지도 SDK에 마커를 표시합니다.

권장 UI 동작:

- 모든 병원이 보이도록 camera bounds 조정
- 내 위치와 병원 마커를 서로 다른 아이콘으로 표시
- 마커 선택 시 병원 카드 강조
- 거리(`distanceM`)는 m 또는 km로 변환
- 전화 버튼과 `placeUrl` 열기 제공
- “현재 진료 가능 여부는 전화 확인 필요” 문구 표시

Web에서 Kakao 지도 SDK를 직접 쓰는 경우 실제 배포 origin을 JavaScript SDK 도메인에 등록해야 합니다. `domain mismatched`가 발생하면 키 문자열보다 도메인 등록을 먼저 확인합니다. 현재 제공 UI는 Kakao 지도 로딩이 실패하면 Leaflet + OpenStreetMap으로 대체합니다.

## 10. WebView/iframe으로 가장 빠르게 넣기

Web 앱:

```html
<iframe
  src="https://chat.example.com"
  title="CareNest 건강 상담"
  allow="microphone; geolocation"
  style="width:100%;height:100%;border:0"
></iframe>
```

React Native 예시:

```tsx
<WebView
  source={{ uri: "https://chat.example.com" }}
  javaScriptEnabled
  geolocationEnabled
  mediaPlaybackRequiresUserAction={false}
/>
```

WebView 방식에서도 OS 앱 권한, WebView의 권한 전달, HTTPS가 모두 필요합니다. iOS `Info.plist`와 Android `AndroidManifest.xml`의 마이크·위치 설명 및 권한을 별도로 설정합니다. 임베드 origin과 챗봇 origin이 다르면 브라우저의 Permissions Policy도 확인합니다.

## 11. 사용자 프로필과 RAG

`childId`가 있으면 다음 function tool이 필요에 따라 실행됩니다.

- `get_user_profile`: 생년월일, 성별, 기저질환, 알레르기, 복용약, 체중 조회
- `update_user_profile`: 사용자가 이번 대화에서 명시적으로 확인한 안정적 정보만 갱신

현재 개발 저장소는 `data/user-profiles.json`입니다. 미리 존재하는 `childId`만 갱신할 수 있습니다. 실제 앱에서는 이 파일을 사용하지 말고 인증된 사용자 DB/Supabase 등의 프로필 저장소로 교체해야 합니다.

외부 앱의 계정 ID를 그대로 `childId`로 노출하기보다 앱 백엔드에서 내부 child ID로 매핑합니다. 프로필 변경에는 다음이 필요합니다.

- 보호자와 아이의 접근 권한 검증
- 변경 전후 값, 시각, 근거 발화의 감사 로그
- 민감정보 암호화와 최소 보관
- 삭제·정정 요청 처리
- 여러 서버 인스턴스의 동시 갱신 제어

RAG 지식은 현재 `src/assistant/knowledge/ingested.json`과 seed 지식에서 검색합니다. 앱별 의료 지식을 추가할 때는 출처와 개정일을 함께 관리하고, 답변의 `sources`를 사용자가 확인할 수 있게 노출하는 것이 좋습니다.

## 12. 세션 수명주기

```text
챗봇 기능 진입
  → 새 sid 생성
  → 동일 상담의 모든 /ask에서 sid 재사용
  → 아이 변경 시 이전 sid reset 후 새 sid 생성
  → 종료/로그아웃 시 /reset 호출
```

```ts
await fetch(`${CARE_NEST_URL}/reset?sid=${encodeURIComponent(sid)}`);
```

현재 대화 이력은 서버 프로세스의 `Map`에 최대 20개 메시지만 저장됩니다.

- 서버 재시작 시 사라집니다.
- 여러 인스턴스 사이에 공유되지 않습니다.
- 인증 없이 `sid`만 알면 reset할 수 있습니다.

운영 환경에서는 Redis/DB 기반 세션, 만료 시간, 사용자 소유권 검증을 추가해야 합니다.

## 13. 오류 및 안전 처리

| 상황 | 앱 동작 |
|---|---|
| `done.error === "empty_question"` | 전송하지 않고 다시 말하기/입력 안내 |
| SSE가 `done` 전에 끊김 | TTS 중지, 부분 답변을 확정 답변으로 저장하지 않기, 명시적 재시도 제공 |
| 위치 미허용 | 문진 유지, 병원 검색 시 위치 재요청 또는 지역 직접 입력 제공 |
| 병원 목록 0개 | 검색 반경/검색어 변경 또는 Kakao 지도 검색 링크 제공 |
| 지도 SDK 실패 | 병원 카드와 외부 지도 링크 유지, 가능한 경우 fallback 지도 표시 |
| `meta.emergency` | 즉시 TTS/화면으로 119 또는 응급실 행동 표시; 지도 검색 때문에 지연시키지 않기 |
| OpenAI/Kakao 장애 | 진단을 추정하지 말고 서비스 장애와 공식 긴급 연락 수단 안내 |

이 기능은 진단·처방 서비스가 아닙니다. 병원 검색 결과도 현재 진료 가능 여부를 보장하지 않으므로 전화 확인이 필요합니다.

## 14. 배포 전 필수 보강

- [ ] `/api/voice/v1`처럼 버전이 있는 앱 공개 API 정의
- [ ] `GET /ask` 대신 body 기반 streaming API 또는 WebSocket 제공
- [ ] 사용자 인증, child 접근 권한, session 소유권 검증
- [ ] allowlist CORS, CSRF 정책, rate limit, request size 제한
- [ ] URL·access log·APM에서 증상, 위치, 식별자 마스킹
- [ ] 프로필 JSON을 암호화된 DB와 감사 로그로 교체
- [ ] 세션 Map을 TTL이 있는 Redis/DB로 교체
- [ ] OpenAI/Kakao timeout, retry, circuit breaker 정의
- [ ] 개인정보·민감정보·위치정보·미성년자 보호자 동의 문구 검토
- [ ] Kakao JavaScript SDK 운영 도메인 등록
- [ ] HTTPS와 모바일 OS 권한 설명문 설정
- [ ] 응급 red-flag 회귀 테스트와 의료 전문가 검토

## 15. 최소 통합 테스트

1. **기본 다중 턴**: “아이가 열이 있어요” → 체온 등 한 가지 후속 질문이 오는지 확인
2. **세션 유지**: 같은 `sid`에서 이미 답한 체온을 다시 묻지 않는지 확인
3. **프로필**: 알려진 `childId`로 체중·알레르기를 명시하고 tool 이벤트와 저장 결과 확인
4. **위치 거부**: 위치 없이 문진은 계속되고 병원 검색만 제한되는지 확인
5. **병원 지도**: 위치 제공 후 `tool.hospitals`의 모든 좌표가 지도와 카드에 표시되는지 확인
6. **응급 우회**: “입술이 파랗고 숨을 못 쉬어요”에서 LLM을 기다리지 않고 `meta.emergency`와 119 안내가 오는지 확인
7. **끼어들기**: 답변 TTS 중 새 발화를 시작하면 기존 stream/TTS가 즉시 취소되는지 확인
8. **연결 장애**: SSE 중단 시 부분 답변이 최종 의료 안내로 저장되지 않는지 확인

## 16. 관련 구현 파일

- HTTP/SSE 서버: `src/server.ts`
- 다중 턴·streaming·red-flag 흐름: `src/pipeline.ts`
- OpenAI function tools: `src/tools.ts`
- 병원 검색 계약: `src/hospitals.ts`
- 사용자 프로필 타입·저장소: `src/assistant/types.ts`, `src/assistant/data/profiles.ts`
- 현재 브라우저 통합 예제: `public/index.html`

현재 계약은 아직 정식 versioning이 적용되지 않은 프로토타입입니다. 다른 앱이 직접 구현 세부사항에 의존하지 않도록 BFF에서 위 계약을 adapter로 감싸고, 이후 CareNest 내부 변경은 adapter 한 곳에서 흡수하는 구성을 권장합니다.
