import { promises as fs } from "fs";
import path from "path";

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__"]);
const TEXT_EXTENSIONS = new Set([".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".sh"]);

// Reads every text file under skillDir and returns { "relative/path.ext": "contents" }
// using forward-slash-normalized relative paths as keys.
export async function readSkillFiles(skillDir: string): Promise<Record<string, string>> {
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

export function normalizeKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

// Resolves a user-supplied relative file path against skillDir, refusing anything
// that would escape it (no "../", no absolute paths). Returns the absolute path or
// null if the path is unsafe or doesn't match an existing file under skillDir.
export function safeResolveWithin(skillDir: string, relPath: string): string | null {
  const normalizedRoot = path.resolve(skillDir);
  const candidate = path.resolve(normalizedRoot, relPath);
  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + path.sep)) {
    return null;
  }
  return candidate;
}

export { TEXT_EXTENSIONS };
