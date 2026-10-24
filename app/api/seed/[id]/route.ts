import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";

// Read-only — these files are bundled with the deployment and never written to,
// which is what actually guarantees the seed fixtures can't be overwritten (not
// application logic enforcing it, the route just has no write path at all).
const SEED_SKILLS: Record<string, string> = {
  "benign-skill": path.join(process.cwd(), "sample-skills", "benign-skill"),
  "malicious-skill": path.join(process.cwd(), "sample-skills", "malicious-skill"),
};

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);
const TEXT_EXTENSIONS = new Set([".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".sh"]);

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

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dir = SEED_SKILLS[id];
  if (!dir) {
    return NextResponse.json({ error: "Unknown seed skill." }, { status: 404 });
  }
  const files = await readSkillFiles(dir);
  return NextResponse.json({ files });
}
