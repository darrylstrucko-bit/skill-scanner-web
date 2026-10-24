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

// The scanner's own line_number is sometimes wrong (observed: a YARA match on a
// multi-line YAML field gets attributed to the field's start line instead of the
// line the matched text is actually on). When a finding carries a snippet of the
// actual matched text, re-derive the line by searching the real file content for
// it rather than trusting the reported number outright.
export function correctLineForSnippet(
  content: string,
  snippet: string | null | undefined,
  reportedLine: number | null
): number | null {
  if (!snippet) return reportedLine;
  const trimmed = snippet.trim();
  if (!trimmed) return reportedLine;

  const lines = content.split("\n");
  const matches: number[] = [];
  lines.forEach((line, idx) => {
    if (line.includes(trimmed)) matches.push(idx + 1);
  });

  if (matches.length === 0) return reportedLine; // can't verify, trust the tool
  if (matches.length === 1) return matches[0];
  if (reportedLine == null) return matches[0];
  // Multiple identical lines (e.g. a duplicated snippet) — pick whichever match
  // is closest to what the tool originally reported.
  return matches.reduce((best, cur) =>
    Math.abs(cur - reportedLine) < Math.abs(best - reportedLine) ? cur : best
  );
}

export { TEXT_EXTENSIONS };
