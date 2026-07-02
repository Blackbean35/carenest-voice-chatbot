import type {
  EmbeddingProvider,
  KnowledgeChunk,
  RetrievedChunk,
} from "./types";
import { cosineSimilarity, salientTokens, overlapCount } from "./embeddings";
import { SEED_KNOWLEDGE } from "./knowledge/seed";

// in-memory 벡터 스토어.
// 실제 앱에서는 이 클래스를 Supabase pgvector 쿼리로 교체합니다.
//   select id, text, source, 1 - (embedding <=> $queryEmbedding) as score
//   from knowledge_chunks order by embedding <=> $queryEmbedding limit k;
// 인터페이스(search)는 동일하게 유지하면 상위 코드 변경이 없습니다.
export class KnowledgeStore {
  private chunks: KnowledgeChunk[] = [];
  private ready = false;

  /**
   * @param embedder 질의 임베딩에 사용 (문서가 이미 임베딩돼 있으면 문서 임베딩은 생략)
   * @param source   지식 청크. embedding이 있으면(=인제스트 결과) 재임베딩하지 않음.
   */
  constructor(
    private embedder: EmbeddingProvider,
    private source: KnowledgeChunk[] = SEED_KNOWLEDGE
  ) {}

  async init(): Promise<void> {
    if (this.ready) return;
    // 임베딩이 없는 청크(시드 등)만 런타임에 임베딩. 인제스트된 청크는 그대로 사용.
    const missing = this.source.filter((c) => !Array.isArray(c.embedding));
    const embeddings = missing.length
      ? await this.embedder.embed(missing.map((c) => c.text))
      : [];
    let j = 0;
    this.chunks = this.source.map((c) =>
      Array.isArray(c.embedding) ? c : { ...c, embedding: embeddings[j++] }
    );
    this.ready = true;
  }

  /** 지식 청크 개수 (부팅 로그/디버깅용) */
  get size(): number {
    return this.chunks.length;
  }

  /**
   * 하이브리드 검색: 임베딩 코사인 + 어휘(lexical) 가중.
   * lexical=겹치는 salient 토큰 수. 나이표현만 겹치는 무관 청크(예: 접종표)는 lexical=0이 되어
   * 상위 인용에서 걸러진다. score는 정렬용 블렌드 점수.
   */
  async search(query: string, k = 3): Promise<RetrievedChunk[]> {
    await this.init();
    const [q] = await this.embedder.embed([query]);
    const qTokens = salientTokens(query);
    return this.chunks
      .map((c) => {
        const cosine = cosineSimilarity(q, c.embedding!);
        const lexical = overlapCount(qTokens, salientTokens(c.text));
        return {
          id: c.id,
          text: c.text,
          source: c.source,
          cosine,
          lexical,
          score: cosine + 0.03 * Math.min(lexical, 5), // 어휘 겹침 소량 가산
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

/**
 * 인제스트 결과(knowledge/ingested.json)를 있으면 로드, 없으면 null.
 * OpenAI 임베딩으로 만든 벡터이므로 openai 모드에서만 사용해야 한다(모델/차원 일치).
 */
export async function loadIngestedChunks(): Promise<KnowledgeChunk[] | null> {
  try {
    // 변수 specifier로 두어, 파일이 없을 때 tsc가 정적 해석 에러를 내지 않도록 함
    const spec = "./knowledge/ingested.json";
    const mod = await import(/* @vite-ignore */ spec, { with: { type: "json" } });
    const data = (mod.default ?? mod) as { chunks?: KnowledgeChunk[] };
    return data.chunks && data.chunks.length ? data.chunks : null;
  } catch {
    return null; // 아직 인제스트 전 → 시드로 폴백
  }
}
