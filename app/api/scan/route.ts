import { execFile } from "child_process";
import path from "path";
import { NextResponse } from "next/server";
import { resolveSkillDir, isKnownSkill, uploadLabel, skillFileOverride } from "@/lib/skillRegistry";
import {
  readSkillFiles,
  normalizeKey,
  correctLineForSnippet,
  inferLineFromFlow,
  NETWORK_LIBRARY_PATTERN,
} from "@/lib/skillFiles";

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

function runScan(skillPath: string, skillFile: string | null): Promise<string> {
  const args = ["scan", skillPath, "--format", "json"];
  if (skillFile) args.push("--skill-file", skillFile);
  return new Promise((resolve, reject) => {
    execFile(
      SKILL_SCANNER_BIN,
      args,
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
      runScan(skillDir, skillFileOverride(skillId)),
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

    type CandidateFlow = { sink_path?: string; source_path?: string; sink_class?: string };
    type RawFinding = {
      file_path?: string | null;
      line_number?: number | null;
      snippet?: string | null;
      metadata?: { semantic_facts?: { candidate_flow?: CandidateFlow } };
      [key: string]: unknown;
    };
    const findings = (result.findings as RawFinding[]).map((f) => {
      const resolvedFile = f.file_path ? byNormalizedKey.get(normalizeKey(f.file_path)) ?? null : null;
      const reportedLine = f.line_number ?? null;
      const correctedLine =
        resolvedFile && files[resolvedFile]
          ? correctLineForSnippet(files[resolvedFile], f.snippet, reportedLine)
          : reportedLine;

      if (correctedLine != null) {
        return {
          ...f,
          resolved_file: resolvedFile,
          line_number: correctedLine,
          reported_line_number: reportedLine,
          line_inferred: false,
        };
      }

      // Still file-level: if the tool's own metadata points at a network flow
      // through a specific file, try to pin an actual line in that file instead
      // of leaving this as a vague file-wide warning.
      const flow = f.metadata?.semantic_facts?.candidate_flow;
      const isNetworkFlow = flow?.sink_class && /network/i.test(flow.sink_class);
      const inferred = isNetworkFlow
        ? inferLineFromFlow(files, byNormalizedKey, flow!.sink_path ?? flow!.source_path, NETWORK_LIBRARY_PATTERN)
        : null;

      return {
        ...f,
        resolved_file: inferred?.file ?? resolvedFile,
        line_number: inferred?.line ?? correctedLine,
        reported_line_number: reportedLine,
        line_inferred: Boolean(inferred),
      };
    });

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
