import { config } from "dotenv";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBrain } from "../src/brain";
import { runVoiceTurn, type ConvoMessage } from "../src/pipeline";
import { Speaker } from "../src/tts";

// 대화형 음성 상담(A안): 질문을 타이핑하면 답을 소리내어 읽어줍니다.
// (실제 앱에서는 타이핑 대신 온디바이스 STT가 이 자리에 들어갑니다.)
const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, "..", ".env") });

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY 없음 (프로젝트 루트의 .env 확인)");
    process.exit(1);
  }
  const brain = await createBrain();
  const speaker = new Speaker();
  let childId: string | undefined;
  let history: ConvoMessage[] = [];

  console.log("\n=== 음성 A안 대화 (타이핑→음성) ===");
  console.log("데모 아이: child-001(생후~1개월) / child-002(생후~17개월, 열성경련 과거력)");
  console.log(":child <id> 로 아이 지정, :quit 종료\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => (closed = true));
  const prompt = () => {
    if (!closed) {
      rl.setPrompt(`아이[${childId ?? "미지정"}] > `);
      rl.prompt();
    }
  };
  prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      prompt();
      continue;
    }
    if (line.startsWith(":")) {
      const [cmd, arg] = line.slice(1).split(/\s+/);
      if (cmd === "quit" || cmd === "exit") break;
      if (cmd === "child") { childId = !arg || arg === "none" ? undefined : arg; history = []; }
      if (cmd === "new" || cmd === "reset") { history = []; console.log("  → 새 상담 시작"); }
      prompt();
      continue;
    }
    const res = await runVoiceTurn(brain, speaker, { question: line, childId, history });
    history = [
      ...history,
      { role: "user" as const, content: line },
      { role: "assistant" as const, content: res.answer },
    ].slice(-16);
    console.log(`\n${res.answer}`);
    console.log(
      `  ⏱ 첫소리 ${Math.round(res.timings.firstAudio ?? 0)}ms` +
        (res.emergency ? `  ⚠️응급(${res.action})` : `  출처: ${res.sources.join(" | ") || "없음"}`) +
        "\n"
    );
    prompt();
  }
  if (!closed) rl.close();
  speaker.close();
  console.log("\n종료합니다. 👶");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
