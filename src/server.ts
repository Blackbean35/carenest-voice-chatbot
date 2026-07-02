import "./config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createBrain } from "./brain";
import { streamTurn, type TurnSink, type ConvoMessage } from "./pipeline";
import { CHAT_MODEL, PORT } from "./config";
import type { UserLocation } from "./tools";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "..", "public", "index.html");

function parseLocation(url: URL): UserLocation | undefined {
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return { lat, lng };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY가 없습니다. .env 또는 기존 서버 .env를 확인하세요.");
    process.exit(1);
  }

  const brain = await createBrain();
  // LRU 세션 스토어: Map의 삽입 순서를 이용해 가장 오래 미사용된 세션부터 제거한다.
  // (프로토타입용 인메모리 저장소. 실제 앱에서는 TTL 있는 외부 세션 스토어로 교체)
  const sessions = new Map<string, ConvoMessage[]>();
  const MAX_HISTORY = 20;
  const MAX_SESSIONS = 500;

  const touchSession = (sid: string, history: ConvoMessage[]) => {
    sessions.delete(sid);
    sessions.set(sid, history);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(INDEX));
      return;
    }

    if (url.pathname === "/client-config") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ kakaoJsKey: process.env.KAKAO_JS_API_KEY || null }));
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          model: CHAT_MODEL,
          ragChunks: brain.store.size,
          kakaoConfigured: Boolean(process.env.KAKAO_REST_API_KEY),
          kakaoMapConfigured: Boolean(process.env.KAKAO_JS_API_KEY),
        })
      );
      return;
    }

    if (url.pathname === "/reset") {
      const sid = url.searchParams.get("sid") || "";
      sessions.delete(sid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/ask") {
      const question = (url.searchParams.get("q") || "").trim();
      const childId = url.searchParams.get("childId") || undefined;
      const sid = url.searchParams.get("sid") || "default";
      const location = parseLocation(url);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      if (!question) {
        send("done", { error: "empty_question" });
        res.end();
        return;
      }

      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      const sink: TurnSink = {
        onMeta: (meta) => send("meta", meta),
        onDelta: (text) => send("delta", { text }),
        onSentence: (text) => send("sentence", { text }),
        onTool: (tool) => send("tool", tool),
      };
      const history = sessions.get(sid) ?? [];

      try {
        const result = await streamTurn(brain, { question, childId, history, location, signal: abort.signal }, sink);
        touchSession(
          sid,
          [
            ...history,
            { role: "user" as const, content: question },
            { role: "assistant" as const, content: result.answer },
          ].slice(-MAX_HISTORY)
        );
        send("done", result);
      } catch (error) {
        if (abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        send("done", { error: message });
      }
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`포트 ${PORT}가 이미 사용 중입니다. PowerShell에서: $env:PORT=5181; npm.cmd run serve`);
      process.exit(1);
    }
    throw error;
  });

  server.listen(PORT, () => {
    console.log("\nCareNest B 음성 문진 서버");
    console.log(`http://localhost:${PORT}`);
    console.log(`model=${CHAT_MODEL}, ragChunks=${brain.store.size}, kakao=${Boolean(process.env.KAKAO_REST_API_KEY)}\n`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
