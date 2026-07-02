import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "tts-worker.ps1");

// 온디바이스 TTS 추상화.
// 로컬(Windows)에서는 SAPI 워커를, Expo RN 앱에서는 expo-speech를 쓰면 됩니다.
// speak()로 문장을 큐에 넣으면 순서대로 소리내어 읽습니다. 첫 발화 시각을 콜백으로 알려줍니다.
export class Speaker {
  private proc: ChildProcess;
  private queue: string[] = [];
  private busy = false;
  private ready = false;
  private pending: string[] = [];
  /** 첫 문장을 실제로 읽기 시작한 시각(performance.now()). 미발화면 undefined */
  firstSpeakAt?: number;

  constructor() {
    this.proc = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WORKER],
      { stdio: ["pipe", "pipe", "inherit"] }
    );
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      if (chunk.includes("__READY__")) {
        this.ready = true;
        for (const s of this.pending) this.enqueue(s);
        this.pending = [];
      }
      if (chunk.includes("__DONE__")) this.next();
    });
  }

  speak(sentence: string): void {
    const s = sentence.replace(/\s+/g, " ").trim();
    if (!s) return;
    if (!this.ready) this.pending.push(s);
    else this.enqueue(s);
  }

  private enqueue(s: string): void {
    this.queue.push(s);
    if (!this.busy) this.next();
  }

  private next(): void {
    const s = this.queue.shift();
    if (s === undefined) {
      this.busy = false;
      return;
    }
    this.busy = true;
    if (this.firstSpeakAt === undefined) this.firstSpeakAt = performance.now();
    this.proc.stdin!.write(s + "\n");
  }

  /** 큐가 빌 때까지(모든 문장 발화 완료) 대기 */
  async drain(): Promise<void> {
    while (this.busy || this.queue.length) await delay(30);
  }

  close(): void {
    try {
      this.proc.stdin!.end();
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
