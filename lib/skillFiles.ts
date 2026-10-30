export function normalizeKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
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

// Extracts the parts of an LLM analyzer's narrative `snippet` that it quoted
// verbatim (backticks for code, single quotes for prose it's describing) —
// longest first, since a longer quote is more likely to be unique and accurate.
// Short quotes (<10 chars) are dropped: too likely to match unrelated text.
function extractQuotedFragments(snippet: string): string[] {
  const fragments: string[] = [];
  const backtickRe = /`([^`]+)`/g;
  const singleQuoteRe = /'([^']{10,})'/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(snippet))) fragments.push(m[1]);
  while ((m = singleQuoteRe.exec(snippet))) fragments.push(m[1]);
  return fragments
    .map((f) => f.replace(/\s+/g, " ").trim())
    .filter((f) => f.length >= 10)
    .sort((a, b) => b.length - a.length);
}

// The LLM semantic/behavioral analyzer describes a finding in its own paraphrased
// narrative rather than quoting one line of matched text, so `correctLineForSnippet`
// (a single-line substring check) never matches it — these findings would otherwise
// stay file-level forever. But the narrative usually quotes the actual offending
// text verbatim somewhere inside it. Flatten the file's lines (joining with a single
// space in place of each newline) so a quote that happens to span a line wrap in the
// source still resolves, then look for each quoted fragment there.
export function findLineForQuotedFragment(content: string, snippet: string | null | undefined): number | null {
  if (!snippet) return null;
  const fragments = extractQuotedFragments(snippet);
  if (fragments.length === 0) return null;

  const lines = content.split("\n");
  const lineStartOffsets: number[] = [];
  let flat = "";
  for (const line of lines) {
    lineStartOffsets.push(flat.length);
    flat += line + " ";
  }

  for (const fragment of fragments) {
    const idx = flat.indexOf(fragment);
    if (idx === -1) continue;
    let line = 0;
    for (let i = 0; i < lineStartOffsets.length; i++) {
      if (lineStartOffsets[i] <= idx) line = i;
      else break;
    }
    return line + 1;
  }
  return null;
}

// Matches common network library imports/calls, used to pin a line for findings
// whose location the scanner only knows at the file level (e.g. "undeclared
// network usage"). Deliberately scoped to network signatures only — this isn't a
// general "find anything" heuristic.
export const NETWORK_LIBRARY_PATTERN =
  /\b(urllib(\.request)?|requests|http\.client|socket|aiohttp|httpx)\b|fetch\(|axios\.|XMLHttpRequest|\bcurl\s|\bwget\s/i;

// Some file-level findings carry a "candidate_flow" in their metadata pointing at
// the file actually responsible (e.g. SKILL.md gets flagged for undeclared network
// use, but the real network call is in a helper script it references). When that's
// present and the flow is network-related, search the real file for a line
// matching `pattern` and use that as the finding's location instead of leaving it
// file-level.
export function inferLineFromFlow(
  files: Record<string, string>,
  byNormalizedKey: Map<string, string>,
  candidatePath: string | undefined,
  pattern: RegExp
): { file: string; line: number } | null {
  if (!candidatePath) return null;
  const resolved = byNormalizedKey.get(normalizeKey(candidatePath));
  if (!resolved) return null;
  const content = files[resolved];
  if (!content) return null;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return { file: resolved, line: i + 1 };
  }
  return null;
}

// Which uploaded file acts as the skill's entry point. If something is already
// literally named SKILL.md, no override is needed; otherwise the first .md file
// (by key order) stands in for it.
export function detectEntryFile(files: Record<string, string>): string | undefined {
  const hasStandard = Object.keys(files).some((f) => f.toLowerCase() === "skill.md");
  if (hasStandard) return undefined;
  return Object.keys(files).find((f) => f.toLowerCase().endsWith(".md"));
}

// Shared between the flat multi-file picker's `accept` attribute and the zip
// upload's own filtering — a zip's entries aren't filtered by `accept` at all
// (that only applies to the OS file-picker dialog), so this list has to be
// enforced in JS for zip uploads to behave the same way.
export const ALLOWED_SKILL_EXTENSIONS = [".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".sh"];

// Directory names that mean "not part of the skill" if they show up inside an
// uploaded zip — someone zipping a whole project folder instead of just the
// skill's own folder would otherwise drag in version control history,
// installed dependencies, and build output.
const NOISE_PATH_SEGMENTS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build"]);

export function isAllowedSkillFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.split("/").some((segment) => NOISE_PATH_SEGMENTS.has(segment))) return false;
  if (lower.endsWith("/.ds_store")) return false;
  return ALLOWED_SKILL_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Zips made by right-click-compress on a folder named "my-skill" wrap every
// entry in a "my-skill/" prefix; zips made from inside the folder (e.g. `zip
// -r out.zip .`) don't. Detect the wrapper and strip it so paths come out
// looking like a real skill package root ("SKILL.md", not "my-skill/SKILL.md")
// — only when every entry actually shares the same first segment, so a zip
// that's already rooted correctly (or has multiple top-level files) is left
// alone rather than having an unrelated prefix chopped off.
export function stripCommonZipPrefix(paths: string[]): string[] {
  if (paths.length === 0) return paths;
  const segments = paths.map((p) => p.split("/"));
  if (segments.some((s) => s.length < 2)) return paths;
  const firstSegment = segments[0][0];
  if (!segments.every((s) => s[0] === firstSegment)) return paths;
  return paths.map((p) => p.slice(firstSegment.length + 1));
}
