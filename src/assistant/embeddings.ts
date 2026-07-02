import type { EmbeddingProvider } from "./types";

// 임베딩 제공자 2종.
// - OpenAIEmbeddings: 실제 임베딩(text-embedding-3-small). OPENAI_API_KEY 필요.
// - LocalEmbeddings: 오프라인 결정적 임베딩(문자 n-gram 해싱). 키 없이 RAG 배선 검증용.
// 둘 다 EmbeddingProvider 인터페이스를 만족하므로 상위 코드는 동일하게 동작합니다.

export class OpenAIEmbeddings implements EmbeddingProvider {
  constructor(
    private client: import("openai").OpenAI,
    private model = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small"
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return res.data.map((d) => d.embedding);
  }
}

/**
 * 외부 의존성 없는 결정적 임베딩 (오프라인 RAG 검증용).
 * 한국어 친화 토크나이저(음절 uni/bi-gram + 영숫자 토큰) + 코퍼스 기반 TF-IDF 가중.
 * 첫 embed 호출(문서 다건)에서 IDF를 학습해, 흔한 음절은 낮추고 변별력 있는 토큰을 키운다.
 * 의미 임베딩만큼 정교하진 않지만 관련 청크를 상위로 올려 데모 검색이 자연스럽게 동작한다.
 */
export class LocalEmbeddings implements EmbeddingProvider {
  private idf = new Map<string, number>();
  private defaultIdf = 1;

  constructor(private dim = 1024) {}

  async embed(texts: string[]): Promise<number[][]> {
    // 코퍼스(문서 다건)가 처음 들어오면 IDF 학습
    if (this.idf.size === 0 && texts.length > 1) this.fit(texts);
    return texts.map((t) => this.embedOne(t));
  }

  private fit(docs: string[]): void {
    const N = docs.length;
    const df = new Map<string, number>();
    for (const doc of docs) {
      for (const tok of new Set(tokenize(doc))) {
        df.set(tok, (df.get(tok) ?? 0) + 1);
      }
    }
    for (const [tok, d] of df) this.idf.set(tok, Math.log(1 + N / d));
    this.defaultIdf = Math.log(1 + N); // 미학습 토큰(질의 전용)은 변별력 높게 취급
  }

  private embedOne(text: string): number[] {
    const vec = new Array(this.dim).fill(0);
    for (const tok of tokenize(text)) {
      const w = this.idf.get(tok) ?? this.defaultIdf;
      vec[hash(tok) % this.dim] += w;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

/** 한국어 음절 uni/bi-gram + 영숫자 토큰 추출 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const runs = text.toLowerCase().match(/[가-힣]+|[a-z0-9]+/g) ?? [];
  for (const run of runs) {
    if (/[가-힣]/.test(run)) {
      for (let i = 0; i < run.length; i++) {
        out.push(run[i]); // 음절 uni-gram
        if (i + 1 < run.length) out.push(run.slice(i, i + 2)); // 음절 bi-gram
      }
    } else {
      out.push(run); // "10kg", "타이레놀" 같은 영숫자 토큰 통째로
    }
  }
  return out;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- 하이브리드 검색용 어휘(lexical) 유틸 ------------------------------------
// 나이/일반 표현은 주제가 달라도 겹치므로(예: 발열 질의 ↔ 접종표의 "생후 N개월")
// salient 토큰 집합에서 제외한다. 이 토큰이 하나도 안 겹치면 주제 무관으로 본다.
const SALIENT_STOP = new Set([
  "개월", "생후", "아이", "영아", "유아", "영유", "아기", "어요", "나요", "하나",
]);

/** 한국어 음절 bi-gram + 영숫자(≥3) 토큰 중 일반어를 제외한 salient 토큰 집합 */
export function salientTokens(text: string): Set<string> {
  const out = new Set<string>();
  const runs = text.toLowerCase().match(/[가-힣]+|[a-z]{3,}/g) ?? [];
  for (const run of runs) {
    if (/[가-힣]/.test(run)) {
      for (let i = 0; i + 1 < run.length; i++) {
        const bg = run.slice(i, i + 2);
        if (!SALIENT_STOP.has(bg)) out.add(bg);
      }
    } else {
      out.add(run);
    }
  }
  return out;
}

/** 두 salient 토큰 집합의 교집합 크기 */
export function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/** 코사인 유사도 (정규화 벡터면 내적과 동일) */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
