import { execFile } from "child_process";
import path from "path";
import { NextResponse } from "next/server";
import { resolveSkillDir, isKnownSkill, uploadLabel } from "@/lib/skillRegistry";
import { readSkillFiles, normalizeKey } from "@/lib/skillFiles";

// Phase 1: trusted local samples plus locally-uploaded folders (see /api/upload).
// Still no network-facing exposure and no real sandboxing — that's phase 2.
const SKILL_SCANNER_BIN =
  process.env.SKILL_SCANNER_BIN ??
  path.join(
    process.env.APPDATA ?? "",
    "Python",
    "Python314",
    "Scripts",
    "skill-scanner.exe"
  );

function runScan(skillPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      SKILL_SCANNER_BIN,
      ["scan", skillPath, "--format", "json"],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const skillId = body?.skillId;

  if (typeof skillId !== "string" || !isKnownSkill(skillId)) {
    return NextResponse.json({ error: "Unknown skillId." }, { status: 400 });
  }

  const skillDir = resolveSkillDir(skillId)!;

  try {
    const [stdout, files] = await Promise.all([
      runScan(skillDir),
      readSkillFiles(skillDir),
    ]);
    const result = JSON.parse(stdout);

    // The scanner is inconsistent about path casing/separators across analyzers
    // (e.g. "SKILL.md" vs "skill.md", "helpers/x.py" vs "helpers\x.py"), so resolve
    // each finding's file_path against our actual file map by normalized key.
    const byNormalizedKey = new Map<string, string>();
    for (const relPath of Object.keys(files)) {
      byNormalizedKey.set(normalizeKey(relPath), relPath);
    }

    type RawFinding = { file_path?: string | null; [key: string]: unknown };
    const findings = (result.findings as RawFinding[]).map((f) => ({
      ...f,
      resolved_file: f.file_path ? byNormalizedKey.get(normalizeKey(f.file_path)) ?? null : null,
    }));

    return NextResponse.json({
      ...result,
      findings,
      files,
      label: uploadLabel(skillId) ?? result.skill_name,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Scan failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
