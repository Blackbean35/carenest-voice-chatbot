import { performance } from "node:perf_hooks";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type { Brain } from "./brain";
import { redFlagCheck, buildRagContext } from "./brain";
import { SentenceSplitter } from "./sentences";
import type { Speaker } from "./tts";
import { CHAT_MODEL } from "./config";
import { CHAT_TOOLS, executeTool, type UserLocation } from "./tools";
import type { HospitalCandidate } from "./hospitals";

const TRIAGE_SYSTEM = `당신은 영유아 보호자를 돕는 한국어 음성 건강 상담원입니다.
목표는 안전한 판단에 필요한 정보를 자연스러운 대화로 충분히 모은 뒤 다음 행동을 한 가지로 안내하는 것입니다.

대화 원칙:
- 음성 대화이므로 매 턴 한두 문장, 한 번에 질문 하나만 말합니다.
- 사용자가 이미 답한 내용과 [아이 정보]에 있는 내용은 다시 묻지 않습니다.
- 첫 증상만으로 결론 내리지 말고 증상별 핵심 정보가 빠졌다면 되묻습니다.
  발열 예: 실제 측정 체온, 시작 시점, 처짐/호흡/경련/발진, 수유와 소변량.
- 충분히 모이면 짧은 평가와 자가관찰/소아과/응급실/119 중 하나의 행동, 악화 관찰점 1~2개를 말합니다.
- 진단이나 처방을 단정하지 않고, 저장된 의료 근거 밖의 사실을 만들어내지 않습니다.
- 일시적 증상은 프로필에 저장하지 않습니다. 사용자가 직접 확인한 체중, 알레르기, 복용약, 기저질환만 update_user_profile로 저장합니다.
- 추가 근거가 필요하면 search_medical_knowledge를 사용합니다.
- 병원 진료가 필요하다는 판단이 끝난 뒤에만 find_nearby_hospitals를 호출합니다. 위치가 없으면 위치 권한이 필요하다고 설명합니다.
- 근처 병원 결과는 최대 3곳만 간단히 안내하고, 운영시간과 진료 가능 여부는 전화 확인하라고 말합니다.
- 응급 신호는 서버가 먼저 처리하지만 대화 중 새로 드러나면 즉시 119를 안내합니다.`;

export interface ConvoMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TurnResult {
  answer: string;
  emergency: boolean;
  action?: string;
  path: "redflag" | "stream";
  sources: string[];
  toolTrace: string[];
  hospitals: HospitalCandidate[];
  timings: Record<string, number>;
}

export interface TurnSink {
  onMeta(m: { emergency: boolean; action?: string; sources: string[] }): void;
  onDelta?(text: string): void;
  onSentence(text: string): void;
  onTool?(event: { name: string; summary: string; hospitals?: HospitalCandidate[] }): void;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export async function streamTurn(
  brain: Brain,
  input: {
    question: string;
    childId?: string;
    history?: ConvoMessage[];
    location?: UserLocation;
    signal?: AbortSignal;
  },
  sink: TurnSink,
  now: Date = new Date()
): Promise<TurnResult> {
  const t0 = performance.now();
  const history = input.history ?? [];
  const flag = await redFlagCheck(input.question, input.childId, now);
  if (flag) {
    const tFlag = performance.now();
    sink.onMeta({ emergency: true, action: flag.action, sources: ["CareNest red-flag 안전규칙"] });
    sink.onSentence(flag.message);
    return {
      answer: flag.message,
      emergency: true,
      action: flag.action,
      path: "redflag",
      sources: ["CareNest red-flag 안전규칙"],
      toolTrace: [],
      hospitals: [],
      timings: { redflag: tFlag - t0, firstAudio: tFlag - t0, done: performance.now() - t0 },
    };
  }

  const recentUser = [...history.filter((m) => m.role === "user").map((m) => m.content), input.question];
  const { relevant, profileNote } = await buildRagContext(
    brain,
    recentUser.slice(-3).join(" "),
    input.childId,
    now
  );
  const tCtx = performance.now();
  const sources = [...new Set(relevant.map((item) => item.source))];
  sink.onMeta({ emergency: false, sources });

  const evidence = relevant.length
    ? relevant.map((item, index) => `(${index + 1}) [${item.source}] ${item.text}`).join("\n")
    : "(관련 근거 없음 ? 일반론을 단정하지 말고 필요한 정보를 먼저 질문)";
  const system = [
    TRIAGE_SYSTEM,
    `[아이 정보] ${profileNote || "선택된 프로필 없음"}`,
    `[위치] ${input.location ? "사용자가 이번 세션에 위치 제공" : "미제공"}`,
    `[참고 근거]\n${evidence}`,
  ].join("\n\n");

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...history.map((item) => ({ role: item.role, content: item.content }) as ChatCompletionMessageParam),
    { role: "user", content: input.question },
  ];

  const splitter = new SentenceSplitter();
  const toolTrace: string[] = [];
  const hospitals: HospitalCandidate[] = [];
  let full = "";
  let firstToken: number | undefined;
  let firstSentence: number | undefined;

  for (let round = 0; round < 4; round++) {
    const stream = await brain.client.chat.completions.create({
      model: CHAT_MODEL,
      stream: true,
      messages,
      tools: CHAT_TOOLS,
      tool_choice: round === 3 ? "none" : "auto",
    }, { signal: input.signal });

    const pending = new Map<number, PendingToolCall>();
    let roundText = "";

    for await (const part of stream) {
      const delta = part.choices[0]?.delta;
      if (delta?.content) {
        if (firstToken === undefined) firstToken = performance.now();
        roundText += delta.content;
        full += delta.content;
        sink.onDelta?.(delta.content);
        for (const sentence of splitter.push(delta.content)) {
          if (firstSentence === undefined) firstSentence = performance.now();
          sink.onSentence(sentence);
        }
      }
      for (const toolDelta of delta?.tool_calls ?? []) {
        const current = pending.get(toolDelta.index) ?? { id: "", name: "", arguments: "" };
        if (toolDelta.id) current.id = toolDelta.id;
        if (toolDelta.function?.name) current.name += toolDelta.function.name;
        if (toolDelta.function?.arguments) current.arguments += toolDelta.function.arguments;
        pending.set(toolDelta.index, current);
      }
    }

    if (roundText) {
      const tail = splitter.flush();
      if (tail) {
        if (firstSentence === undefined) firstSentence = performance.now();
        sink.onSentence(tail);
      }
    }

    const calls = [...pending.values()].filter((call) => call.id && call.name);
    if (calls.length === 0) break;

    const toolCalls: ChatCompletionMessageToolCall[] = calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
    messages.push({ role: "assistant", content: roundText || null, tool_calls: toolCalls });

    for (const call of calls) {
      toolTrace.push(call.name);
      let output: string;
      try {
        output = await executeTool(call.name, call.arguments, {
          brain,
          childId: input.childId,
          location: input.location,
          onTool: (event) => {
            if (event.hospitals) hospitals.push(...event.hospitals);
            sink.onTool?.(event);
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output = JSON.stringify({ status: "error", message });
        sink.onTool?.({ name: call.name, summary: `도구 오류: ${message}` });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }

  const genDone = performance.now();
  return {
    answer: full.trim(),
    emergency: false,
    path: "stream",
    sources,
    toolTrace,
    hospitals,
    timings: {
      ctx: tCtx - t0,
      firstToken: (firstToken ?? tCtx) - t0,
      firstAudio: (firstSentence ?? genDone) - t0,
      genDone: genDone - t0,
    },
  };
}

export async function runVoiceTurn(
  brain: Brain,
  speaker: Speaker,
  input: {
    question: string;
    childId?: string;
    history?: ConvoMessage[];
    location?: UserLocation;
  },
  now: Date = new Date()
): Promise<TurnResult> {
  speaker.firstSpeakAt = undefined;
  const sink: TurnSink = {
    onMeta: () => {},
    onSentence: (sentence) => speaker.speak(sentence),
  };
  const result = await streamTurn(brain, input, sink, now);
  await speaker.drain();
  return result;
}
