# CareNest B - 저지연 음성 문진 + RAG + 도구 호출

브라우저 음성 인식/합성, 서버 스트리밍, 결정적 응급 규칙, 다중 턴 문진과 OpenAI Function Calling을 결합한 독립 프로토타입입니다.

## 구현 범위

- **저지연 음성 대화**: 브라우저 Web Speech의 interim transcript, 문장 단위 TTS, 자동 재청취, 답변 중 끼어들기
- **다중 턴 문진**: 한 번에 질문 하나만 묻고, 이전 답변과 프로필에 있는 내용은 다시 묻지 않음
- **RAG**: `src/assistant/knowledge/ingested.json` 및 seed 지식을 하이브리드 검색
- **사용자 프로필**: `data/user-profiles.json` 조회/갱신. 체중·알레르기·복용약·기저질환처럼 사용자가 명시한 안정적 정보만 저장
- **병원 안내**: 문진 결과 진료가 필요할 때 `find_nearby_hospitals` Function Calling으로 카카오 Local API 호출
- **안전 경로**: 청색증·호흡곤란·의식저하·경련 등은 LLM/RAG보다 먼저 로컬 규칙으로 119 안내

## 실행

PowerShell:

```powershell
cd carenest-voice-chatbot
npm.cmd install
npm.cmd run typecheck
npm.cmd run test:offline
npm.cmd run serve
```

Chrome 또는 Edge에서 [http://localhost:5180](http://localhost:5180)을 엽니다.

`.env.example`을 `.env`로 복사하고 아래 키를 채웁니다.

```dotenv
OPENAI_API_KEY=...
OPENAI_CHAT_MODEL=gpt-5.4-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
KAKAO_REST_API_KEY=...
KAKAO_JS_API_KEY=...
PORT=5180
```

카카오 앱에서 Kakao Map 기능을 활성화하고 REST API 키와 JavaScript 키를 설정해야 합니다.
REST API 키는 서버에서만 사용합니다. JavaScript 키는 지도 SDK 로딩을 위해 브라우저에 전달되므로
카카오 개발자 콘솔에서 `http://localhost:5180`과 실제 배포 도메인만 허용하도록 제한해야 합니다.
페이지를 열면 마이크·위치 사용 동의 모달이 먼저 표시되고, 동의 버튼을 누른 뒤 브라우저 권한 요청이 이어집니다.

## 데모 순서

1. **대화형 문진**
   - 사용자: “아이가 열이 있어요.”
   - 기대: 바로 결론 내리지 않고 “체온을 측정해 보셨나요?”처럼 질문 하나를 되묻습니다.
2. **프로필 저장**
   - 사용자: “몸무게는 10.2kg이고 페니실린 알레르기가 있어요.”
   - 기대: `update_user_profile` 도구가 명시된 정보를 저장합니다.
3. **병원 안내**
   - 첫 화면에서 마이크·위치 사용에 동의합니다.
   - 체온·기간·동반증상 문진 후 진료가 필요하다고 판단되면 카카오 병원 검색 도구가 호출되고 지도·마커·병원 카드가 함께 표시됩니다.
4. **응급 우회**
   - 사용자: “아이 입술이 파랗고 숨을 못 쉬어요.”
   - 기대: OpenAI 호출을 기다리지 않고 즉시 119를 안내합니다.
5. **끼어들기**
   - 답변을 읽는 중 **말하기**를 누르면 현재 음성과 스트림을 중단하고 새 발화를 받습니다.

서버 상태는 [http://localhost:5180/health](http://localhost:5180/health)에서 확인할 수 있습니다.

## 구조

```text
브라우저 마이크
  -> Web Speech STT(interim/final)
  -> 서버 red-flag 규칙
  -> RAG + 사용자 프로필 병렬 조회
  -> gpt-5.4-mini streaming + function tools
       - search_medical_knowledge
       - get_user_profile
       - update_user_profile
       - find_nearby_hospitals
  -> SSE 텍스트/문장/도구 이벤트
  -> 브라우저 문장 단위 TTS + Kakao 지도/마커 + 병원 카드
```

OpenAI의 직접 speech-to-speech Realtime API가 더 낮은 지연을 제공하지만, 이 프로토타입은 의료 문진에서 중간 텍스트 기록, 서버 측 결정적 안전검사, 프로필 변경 경계를 유지하기 위해 chained 구조를 사용합니다.

- OpenAI voice agents: https://developers.openai.com/api/docs/guides/voice-agents
- OpenAI function tools: https://developers.openai.com/api/docs/guides/function-calling
- Kakao Local REST API: https://developers.kakao.com/docs/en/local/dev-guide

## 안전 및 운영상 한계

- 의료 진단/처방을 대신하지 않는 프로토타입입니다.
- 병원 검색 결과는 현재 영업/진료 가능 여부를 보장하지 않으므로 전화 확인이 필요합니다.
- 위치는 브라우저 세션에서만 전달하며 프로필 JSON에 저장하지 않습니다.
- 프로필 JSON은 개발용입니다. 실제 서비스에서는 사용자 인증, 접근통제, 암호화, 변경 감사 로그가 있는 DB로 교체해야 합니다.
- OpenAI로 대화 내용과 검색에 필요한 의료 지식 일부가 전송됩니다. 실제 개인정보를 사용하기 전에 개인정보 처리와 동의 절차를 설계해야 합니다.
## 지도 오류 해결

Kakao 응답이 `domain mismatched`이면 코드나 키 형식 문제가 아니라 JavaScript SDK 허용 도메인 문제입니다.

1. Kakao Developers에서 해당 JavaScript 키를 가진 앱을 엽니다.
2. **앱 > 플랫폼 키 > JavaScript 키 > JavaScript SDK 도메인**으로 이동합니다.
3. `http://localhost:5180`을 등록한 뒤 저장합니다.
4. 서버를 다시 시작하고 브라우저를 새로고침합니다.

스킴·호스트·포트가 실제 호출 주소와 일치해야 합니다. Kakao 인증이 실패하는 동안에도 병원 좌표는
Kakao Local REST API에서 가져오며, 화면 지도는 Leaflet + OpenStreetMap으로 자동 대체됩니다.
