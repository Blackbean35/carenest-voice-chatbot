import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProfile } from "../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(HERE, "..", "..", "..", "data", "user-profiles.json");
const PROFILE_FILE = process.env.USER_PROFILE_PATH || DEFAULT_FILE;

const SEED_PROFILES: Record<string, ChildProfile> = {
  "child-001": { id: "child-001", birthDate: "2026-05-10", sex: "female", underlyingConditions: [] },
  "child-002": {
    id: "child-002",
    birthDate: "2025-01-15",
    sex: "male",
    underlyingConditions: ["열성경련 과거력"],
  },
};

export type ProfilePatch = Partial<
  Pick<
    ChildProfile,
    "birthDate" | "sex" | "underlyingConditions" | "allergies" | "medications" | "weightKg" | "guardianNotes"
  >
>;

let writeQueue: Promise<void> = Promise.resolve();

async function readProfiles(): Promise<Record<string, ChildProfile>> {
  try {
    return JSON.parse(await readFile(PROFILE_FILE, "utf8")) as Record<string, ChildProfile>;
  } catch {
    return structuredClone(SEED_PROFILES);
  }
}

export async function fetchChildProfile(childId: string): Promise<ChildProfile | null> {
  const profiles = await readProfiles();
  return profiles[childId] ?? null;
}

/** 명시적으로 확인된 사용자 진술만 저장하도록 상위 도구에서 호출한다. */
export async function updateChildProfile(childId: string, patch: ProfilePatch): Promise<ChildProfile> {
  let updated!: ChildProfile;
  writeQueue = writeQueue.then(async () => {
    const profiles = await readProfiles();
    const current = profiles[childId];
    if (!current) throw new Error(`알 수 없는 사용자 프로필: ${childId}`);
    updated = { ...current, ...patch, id: childId, updatedAt: new Date().toISOString() };
    profiles[childId] = updated;
    await writeFile(PROFILE_FILE, JSON.stringify(profiles, null, 2) + "\n", "utf8");
  });
  await writeQueue;
  return updated;
}

/** 생년월일로부터 개월수 계산 */
export function ageInMonths(birthDate: string, now: Date = new Date()): number {
  const b = new Date(birthDate);
  let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (now.getDate() < b.getDate()) months -= 1;
  return Math.max(0, months);
}
