import { randomUUID } from "crypto";
import path from "path";
import { NextResponse } from "next/server";
import {
  resolveSkillDir,
  isKnownSkill,
  registerUpload,
  UPLOADS_ROOT,
  skillFileOverride,
  uploadLabel,
  isSeedSkill,
} from "@/lib/skillRegistry";
import { copyDirRecursive } from "@/lib/skillFiles";

// Clones a skill (seed or already-uploaded) into a new, independently-editable
// working copy under .uploads/<id>. Called before the first edit of a seed skill
// so Edit/Save never writes into the committed sample-skills fixtures.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const skillId = body?.skillId;

  if (typeof skillId !== "string" || !isKnownSkill(skillId)) {
    return NextResponse.json({ error: "Unknown skillId." }, { status: 400 });
  }

  const sourceDir = resolveSkillDir(skillId)!;
  const rawId = randomUUID();
  const newSkillId = `upload:${rawId}`;
  const newDir = path.join(UPLOADS_ROOT, rawId);

  try {
    await copyDirRecursive(sourceDir, newDir);
    const baseLabel = isSeedSkill(skillId) ? skillId : uploadLabel(skillId) ?? skillId;
    const label = `${baseLabel} (edited copy)`;
    registerUpload(newSkillId, newDir, label, skillFileOverride(skillId) ?? undefined);
    return NextResponse.json({ skillId: newSkillId, label });
  } catch (err) {
    return NextResponse.json(
      { error: "Fork failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
