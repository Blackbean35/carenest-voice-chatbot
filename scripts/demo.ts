import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBrain } from "../src/brain";
import { runVoiceTurn } from "../src/pipeline";
import { Speaker } from "../src/tts";

// 프로젝트 루트의 로컬 환경 설정 사용
const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, "..", ".env") });

const NOW = new Date("2026-07-02T09:00:00+09:00");

const CASES: { title: string; question: string; childId?: string }[] = [
  { title: "응급(red-flag) — LLM 없이 즉답", question: "아이 입술이 파랗게 변했어요" },
  { title: "일반 상담(RAG+프로필)", question: "아이가 열이 나는데 어떻게 해요?", childId: "child-002" },
  { title: "해열제 용량(RAG)", question: "10kg 아기 타이레놀 얼마나 먹여요?" },
];

function ms(n: number | undefined) {
  return n === undefined ? "  -  " : `${Math.round(n)}ms`;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY 없음 (프로젝트 루트의 .env 확인)");
    process.exit(1);
  }
  const brain = await createBrain();
  const speaker = new Speaker();

  console.log("\n=== 음성 A안: 스트리밍 텍스트 파이프라인 지연 측정 ===");
  console.log("(t0 = 사용자가 말을 멈춘 시점. firstAudio = 첫 소리 시작까지)\n");

  for (const c of CASES) {
    const res = await runVoiceTurn(brain, speaker, c, NOW);
    const t = res.timings;
    console.log(`▶ ${c.title}`);
    console.log(`  Q: ${c.question}`);
    console.log(`  A: ${res.answer}`);
    console.log(
      `  ⏱  RAG준비=${ms(t.ctx)}  첫토큰=${ms(t.firstToken)}  ` +
        `첫소리=${ms(t.firstAudio)}  생성완료=${ms(t.genDone)}  발화완료=${ms(t.speakDone)}`
    );
    console.log(
      `  ${res.emergency ? `⚠️ 응급(${res.action})` : `출처: ${res.sources.join(" | ") || "없음"}`}\n`
    );
  }

  speaker.close();
  console.log("핵심 지표: '첫소리' = 사용자가 말을 멈춘 뒤 응답 음성이 나오기 시작한 시간.\n");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
