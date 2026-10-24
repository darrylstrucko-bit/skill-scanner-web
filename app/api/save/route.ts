import { promises as fs } from "fs";
import { NextResponse } from "next/server";
import { resolveSkillDir, isKnownSkill, isSeedSkill } from "@/lib/skillRegistry";
import { safeResolveWithin } from "@/lib/skillFiles";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const skillId = body?.skillId;
  const file = body?.file;
  const content = body?.content;

  if (typeof skillId !== "string" || !isKnownSkill(skillId)) {
    return NextResponse.json({ error: "Unknown skillId." }, { status: 400 });
  }
  if (typeof file !== "string" || typeof content !== "string") {
    return NextResponse.json({ error: "Missing file or content." }, { status: 400 });
  }
  // Seed fixtures (benign-skill/malicious-skill) are never writable — callers must
  // fork via /api/fork first and save into the resulting upload:<id> instead.
  if (isSeedSkill(skillId)) {
    return NextResponse.json(
      { error: "Refused: seed skills are read-only. Fork it first via /api/fork." },
      { status: 403 }
    );
  }

  const skillDir = resolveSkillDir(skillId)!;
  const target = safeResolveWithin(skillDir, file);
  if (!target) {
    return NextResponse.json({ error: "Refused: path escapes skill directory." }, { status: 400 });
  }

  try {
    await fs.writeFile(target, content, "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Save failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
