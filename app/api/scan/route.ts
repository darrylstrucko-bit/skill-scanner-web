import { execFile } from "child_process";
import { promises as fs } from "fs";
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

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);
const TEXT_EXTENSIONS = new Set([".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".sh"]);

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

// Reads every text file under skillDir and returns { "relative/path.ext": "contents" }
// using forward-slash-normalized relative paths as keys.
async function readSkillFiles(skillDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const relPath = path.relative(skillDir, fullPath).split(path.sep).join("/");
        out[relPath] = await fs.readFile(fullPath, "utf-8");
      }
    }
  }

  await walk(skillDir);
  return out;
}

function normalizeKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
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

  const skillDir = SAMPLE_SKILLS[skillId];

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

    return NextResponse.json({ ...result, findings, files });
  } catch (err) {
    return NextResponse.json(
      { error: "Scan failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
