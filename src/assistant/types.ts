// 어시스턴트 모듈 공용 타입
// 실제 앱(Next.js Route Handler)과 데모가 동일하게 참조합니다.

/** 아이 프로필 (실제 앱에서는 Supabase child_profile 테이블에서 조회) */
export interface ChildProfile {
  id: string;
  birthDate: string; // ISO date (YYYY-MM-DD)
  sex?: "male" | "female";
  allergies?: string[];
  medications?: string[];
  weightKg?: number;
  guardianNotes?: string;
  updatedAt?: string;

  underlyingConditions?: string[]; // 기저질환 (트리아지 가중치)
}

/** 의료 지식 청크 (RAG 대상). 실제 앱에서는 Supabase pgvector에 저장 */
export interface KnowledgeChunk {
  id: string;
  text: string;
  source: string; // 출처 표기 (환각 방지 / 신뢰성)
  embedding?: number[];
}

/** RAG 검색 결과 1건 */
export interface RetrievedChunk {
  id: string;
  text: string;
  source: string;
  score: number; // 하이브리드 점수(코사인 + 소량의 어휘 가중)
  cosine: number; // 순수 임베딩 코사인 유사도
  lexical: number; // 질의와 겹치는 salient 토큰 수 (0이면 주제 무관으로 간주)
}

/** LLM에 넘기는 대화 메시지 (OpenAI/Claude 공통으로 매핑되는 최소 형태) */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCallId?: string; // role: "tool" 일 때 어떤 호출에 대한 응답인지
  toolCalls?: ToolCallRequest[]; // role: "assistant" 가 도구 호출을 요청한 경우
}

/** LLM이 요청한 도구 호출 1건 */
export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 도구 정의: 스키마(LLM 노출용) + 실제 실행 함수 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/** LLM 추상화. OpenAI 구현과 mock 구현이 이 인터페이스를 만족합니다. */
export interface LLMClient {
  chat(
    messages: ChatMessage[],
    tools: ToolDefinition[]
  ): Promise<{ content: string | null; toolCalls: ToolCallRequest[] }>;
}

/** 임베딩 제공자 추상화 (OpenAI 임베딩 / 오프라인 로컬 임베딩) */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

/** askHealthAssistant 입력 */
export interface AssistantInput {
  question: string;
  childId?: string; // 개인화를 위한 아이 식별자
  temperatureC?: number; // 측정 체온이 있으면 red-flag 연령가중 판단에 사용
}

/** askHealthAssistant 출력 */
export interface AssistantResult {
  answer: string;
  emergency: boolean; // red-flag에 걸려 즉시 에스컬레이션 된 경우 true
  action?: "119" | "ER" | "clinic" | "self_observe";
  sources: string[]; // 답변 근거로 사용된 출처 목록 (citation)
  toolTrace: string[]; // 어떤 도구를 어떤 순서로 호출했는지 (agent다움 증빙/디버깅)
  mode: "openai" | "mock"; // 어떤 LLM 백엔드로 응답했는지
}
