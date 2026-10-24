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
