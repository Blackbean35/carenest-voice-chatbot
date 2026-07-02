import assert from "node:assert/strict";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const profilePath = join(tmpdir(), `voice-b-profile-smoke-${process.pid}.json`);
process.env.RAG_EMBEDDING_MODE = "local";
process.env.USER_PROFILE_PATH = profilePath;
process.env.OPENAI_API_KEY ||= "offline-placeholder";

async function main() {
  const [{ createBrain, redFlagCheck, searchKnowledge }, { executeTool }] = await Promise.all([
    import("../src/brain"),
    import("../src/tools"),
  ]);
  const brain = await createBrain();

  const emergency = await redFlagCheck("아이 입술이 파랗게 변했어요", "child-002", new Date());
  assert.equal(emergency?.action, "119");

  const knowledge = await searchKnowledge(brain, "아기 발열 체온 해열제");
  assert.ok(knowledge.length > 0, "local RAG should return at least one relevant chunk");

  const updated = JSON.parse(
    await executeTool(
      "update_user_profile",
      JSON.stringify({ weightKg: 10.2, evidence: "아이 몸무게는 10.2kg이에요" }),
      { brain, childId: "child-002" }
    )
  ) as { status: string; profile: { weightKg?: number } };
  assert.equal(updated.status, "updated");
  assert.equal(updated.profile.weightKg, 10.2);

  const locationMissing = JSON.parse(
    await executeTool(
      "find_nearby_hospitals",
      JSON.stringify({ query: "소아과", reason: "진료 필요" }),
      { brain, childId: "child-002" }
    )
  ) as { status: string };
  assert.equal(locationMissing.status, "location_required");

  console.log("offline smoke: red-flag, local RAG, profile update, location guard OK");
}

main()
  .finally(() => rm(profilePath, { force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
