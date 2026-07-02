import "./config";
import OpenAI from "openai";
import { KnowledgeStore, loadIngestedChunks } from "./assistant/knowledgeStore";
import { LocalEmbeddings, OpenAIEmbeddings } from "./assistant/embeddings";
import { SEED_KNOWLEDGE } from "./assistant/knowledge/seed";
import { checkRedFlags, type RedFlagHit } from "./assistant/redFlags";
import { fetchChildProfile, ageInMonths } from "./assistant/data/profiles";
import type { ChildProfile, RetrievedChunk } from "./assistant/types";

export interface Brain {
  client: OpenAI;
  store: KnowledgeStore;
}

export async function createBrain(): Promise<Brain> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "offline-placeholder" });
  const local = process.env.RAG_EMBEDDING_MODE === "local";
  const ingested = local ? null : await loadIngestedChunks();
  const knowledge = local ? SEED_KNOWLEDGE : [...(ingested ?? []), ...SEED_KNOWLEDGE];
  const embedder = local ? new LocalEmbeddings() : new OpenAIEmbeddings(client);
  const store = new KnowledgeStore(embedder, knowledge);
  await store.init();
  return { client, store };
}

export interface RagContext {
  relevant: RetrievedChunk[];
  profile: ChildProfile | null;
  profileNote: string | null;
}

export function redFlagCheck(question: string, childId: string | undefined, now: Date): Promise<RedFlagHit | null> {
  return checkRedFlags({ question, childId }, now);
}

export async function searchKnowledge(brain: Brain, query: string): Promise<RetrievedChunk[]> {
  const hits = await brain.store.search(query, 5);
  return hits.filter((h) => h.cosine >= 0.25 && h.lexical > 0).slice(0, 3);
}

export async function buildRagContext(
  brain: Brain,
  question: string,
  childId: string | undefined,
  now: Date
): Promise<RagContext> {
  const [relevant, profile] = await Promise.all([
    searchKnowledge(brain, question),
    childId ? fetchChildProfile(childId) : Promise.resolve(null),
  ]);

  let profileNote: string | null = null;
  if (profile) {
    const details = [
      `생후 ${ageInMonths(profile.birthDate, now)}개월`,
      profile.sex === "female" ? "여아" : profile.sex === "male" ? "남아" : "성별 미상",
      `기저질환 ${profile.underlyingConditions?.join(", ") || "없음"}`,
      `알레르기 ${profile.allergies?.join(", ") || "미기록"}`,
      `복용약 ${profile.medications?.join(", ") || "미기록"}`,
      profile.weightKg ? `체중 ${profile.weightKg}kg` : "체중 미기록",
    ];
    profileNote = details.join(", ");
  }
  return { relevant, profile, profileNote };
}
