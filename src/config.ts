import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// 공개 저장소는 프로젝트 루트의 .env만 읽는다.
config({ path: join(ROOT, ".env") });

export const APP_ROOT = ROOT;
export const PORT = Number(process.env.PORT || 5180);
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-5.4-mini";
