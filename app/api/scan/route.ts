import { execFile } from "child_process";
import path from "path";
import { NextResponse } from "next/server";

// Phase 1: local, trusted-input only. No upload surface — scan targets are a fixed
// whitelist of sample skill directories we wrote ourselves. Do NOT accept an
// arbitrary filesystem path or user-supplied string here even after this moves to
// a web-facing phase; that's exactly the sandboxing work phase 2 is for.
const SAMPLE_SKILLS: Record<string, string> = {
  "benign-skill": path.join(process.cwd(), "sample-skills", "benign-skill"),
  "malicious-skill": path.join(process.cwd(), "sample-skills", "malicious-skill"),
};

// Override with SKILL_SCANNER_BIN if your install location differs.
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

  if (typeof skillId !== "string" || !(skillId in SAMPLE_SKILLS)) {
    return NextResponse.json(
      { error: "Unknown skillId. Must be one of: " + Object.keys(SAMPLE_SKILLS).join(", ") },
      { status: 400 }
    );
  }

  try {
    const stdout = await runScan(SAMPLE_SKILLS[skillId]);
    const result = JSON.parse(stdout);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Scan failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
