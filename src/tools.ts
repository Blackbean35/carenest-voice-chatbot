import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Brain } from "./brain";
import { searchKnowledge } from "./brain";
import { fetchChildProfile, updateChildProfile, type ProfilePatch } from "./assistant/data/profiles";
import { findNearbyHospitals, type HospitalCandidate } from "./hospitals";

export interface UserLocation {
  lat: number;
  lng: number;
}

export interface ToolContext {
  brain: Brain;
  childId?: string;
  location?: UserLocation;
  onTool?: (event: { name: string; summary: string; hospitals?: HospitalCandidate[] }) => void;
}

export const CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_medical_knowledge",
      description: "현재 증상과 관련된 저장된 의료 지식 근거를 RAG로 다시 검색한다.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "검색할 증상과 핵심 문맥" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_profile",
      description: "현재 선택된 아이의 저장된 나이, 기저질환, 알레르기, 복용약, 체중 정보를 읽는다.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "update_user_profile",
      description:
        "사용자가 이번 대화에서 명시적으로 확인한 안정적 정보(체중·알레르기·복용약·기저질환)만 현재 아이 프로필에 저장한다. 추론한 정보나 생년월일·성별 같은 식별 정보는 저장하지 않는다.",
      parameters: {
        type: "object",
        properties: {
          underlyingConditions: { type: "array", items: { type: "string" } },
          allergies: { type: "array", items: { type: "string" } },
          medications: { type: "array", items: { type: "string" } },
          weightKg: { type: "number", minimum: 0.5, maximum: 100 },
          guardianNotes: { type: "string", maxLength: 500 },
          evidence: { type: "string", description: "사용자가 직접 말한 근거 문장" },
        },
        required: ["evidence"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_nearby_hospitals",
      description: "문진 결과 병원 진료가 필요하다고 판단된 경우에만 현재 위치 기준으로 카카오 로컬 API에서 병원을 검색한다.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "예: 소아과, 소아응급실" },
          radiusM: { type: "integer", minimum: 500, maximum: 20000 },
          reason: { type: "string", description: "병원 안내가 필요하다고 판단한 이유" },
        },
        required: ["query", "reason"],
        additionalProperties: false,
      },
    },
  },
];

function asObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("잘못된 도구 인자입니다.");
  return parsed as Record<string, unknown>;
}

export async function executeTool(name: string, rawArguments: string, context: ToolContext): Promise<string> {
  const args = asObject(rawArguments);
  if (name === "search_medical_knowledge") {
    const query = String(args.query || "").trim();
    if (!query) throw new Error("검색어가 필요합니다.");
    const hits = await searchKnowledge(context.brain, query);
    context.onTool?.({ name, summary: `의료 지식 ${hits.length}건 검색` });
    return JSON.stringify({
      results: hits.map((hit) => ({ source: hit.source, text: hit.text, relevance: Number(hit.score.toFixed(3)) })),
    });
  }

  if (name === "get_user_profile") {
    if (!context.childId) return JSON.stringify({ status: "child_not_selected" });
    const profile = await fetchChildProfile(context.childId);
    context.onTool?.({ name, summary: profile ? "사용자 프로필 조회" : "프로필 없음" });
    return JSON.stringify({ status: profile ? "ok" : "not_found", profile });
  }

  if (name === "update_user_profile") {
    if (!context.childId) return JSON.stringify({ status: "child_not_selected" });
    const evidence = String(args.evidence || "").trim();
    if (!evidence) throw new Error("프로필 변경에는 사용자 발화 근거가 필요합니다.");
    const allowed = [
      "underlyingConditions",
      "allergies",
      "medications",
      "weightKg",
      "guardianNotes",
    ] as const;
    const patch: ProfilePatch = {};
    for (const key of allowed) if (args[key] !== undefined) Object.assign(patch, { [key]: args[key] });
    if (Object.keys(patch).length === 0) throw new Error("저장할 프로필 필드가 없습니다.");
    const updated = await updateChildProfile(context.childId, patch);
    context.onTool?.({ name, summary: `프로필 갱신: ${Object.keys(patch).join(", ")}` });
    return JSON.stringify({ status: "updated", evidence, profile: updated });
  }

  if (name === "find_nearby_hospitals") {
    if (!context.location) return JSON.stringify({ status: "location_required" });
    const hospitals = await findNearbyHospitals({
      ...context.location,
      query: String(args.query || "소아과"),
      radiusM: Number(args.radiusM || 5000),
    });
    context.onTool?.({ name, summary: `근처 병원 ${hospitals.length}곳 검색`, hospitals });
    return JSON.stringify({ status: "ok", reason: String(args.reason || ""), hospitals });
  }

  throw new Error(`지원하지 않는 도구: ${name}`);
}
