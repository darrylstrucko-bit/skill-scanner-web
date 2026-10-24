import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import { detectEntryFile, normalizeKey, correctLineForSnippet, inferLineFromFlow, NETWORK_LIBRARY_PATTERN } from "./skillFiles";

// Stateless by design: the caller always sends the full current file set, and we
// never write anything the caller can't see back in the response. No server-side
// registry, no persisted working copies — this works identically whether we're
// running locally (shelling out to the CLI) or on Vercel (which has neither a
// writable persistent disk nor a shared process, so anything stateful silently
// breaks there).

const MAX_FILES = 50;
const MAX_FILE_BYTES = 256 * 1024; // 256KB per file — generous for skill text files
const MAX_TOTAL_BYTES = 2 * 1024 * 1024; // 2MB total

export class ScanInputError extends Error {}

// Fast, synchronous size/count checks before any zipping, temp-file writes, or
// network calls — the actual fix for the "12.7s to reject an oversized upload"
// problem: reject in microseconds based on the content we already have in memory,
// instead of letting the scanner (local or remote) spend real work discovering
// the same thing.
export function validateFiles(files: Record<string, string>): void {
  const names = Object.keys(files);
  if (names.length === 0) throw new ScanInputError("No files provided.");
  if (names.length > MAX_FILES) throw new ScanInputError(`Too many files (max ${MAX_FILES}).`);
  let total = 0;
  for (const name of names) {
    const bytes = Buffer.byteLength(files[name], "utf-8");
    if (bytes > MAX_FILE_BYTES) {
      throw new ScanInputError(`${name} exceeds the per-file size limit (${MAX_FILE_BYTES} bytes).`);
    }
    total += bytes;
    if (total > MAX_TOTAL_BYTES) {
      throw new ScanInputError(`Upload exceeds the total size limit (${MAX_TOTAL_BYTES} bytes).`);
    }
  }
}

const SKILL_SCANNER_BIN =
  process.env.SKILL_SCANNER_BIN ??
  path.join(process.env.APPDATA ?? "", "Python", "Python314", "Scripts", "skill-scanner.exe");

function execFilePromise(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function scanLocal(files: Record<string, string>): Promise<string> {
  const entryFile = detectEntryFile(files);
  const tmpDir = path.join(os.tmpdir(), `skill-scan-${randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const target = path.join(tmpDir, ...relPath.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf-8");
    }
    const args = ["scan", tmpDir, "--format", "json"];
    if (entryFile) args.push("--skill-file", entryFile);
    return await execFilePromise(SKILL_SCANNER_BIN, args, 30_000);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// The remote API has no equivalent of the CLI's --skill-file override — it
// requires a literal SKILL.md inside the zip. When the real entry file has a
// different name, we rename it to SKILL.md inside the zip we build (display-only
// elsewhere; the caller's own filenames are untouched) and remember the mapping
// so findings reported against "SKILL.md" get attributed back to the real name.
async function scanRemote(files: Record<string, string>, apiUrl: string): Promise<string> {
  const entryFile = detectEntryFile(files);
  const zip = new JSZip();
  for (const [relPath, content] of Object.entries(files)) {
    const zipPath = entryFile && relPath === entryFile ? "SKILL.md" : relPath;
    zip.file(zipPath, content);
  }
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(zipBuffer)], { type: "application/zip" }), "skill.zip");

  // Render's free tier spins a service down after 15 minutes idle and takes up to
  // ~60s to wake it back up on the next request (per Render's own docs) — a 30s
  // timeout here would abort mid-wakeup on exactly the requests that need it most.
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/scan-upload`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Remote scanner returned ${res.status}: ${text}`);
  }
  if (entryFile) {
    // Rewrite "SKILL.md" / "skill.md" back to the real filename in the raw JSON
    // before anyone downstream tries to resolve file paths against our files map.
    return text.replace(/"file_path"\s*:\s*"[Ss][Kk][Ii][Ll][Ll]\.md"/g, `"file_path":"${entryFile}"`);
  }
  return text;
}

type RawFinding = {
  file_path?: string | null;
  line_number?: number | null;
  snippet?: string | null;
  metadata?: { semantic_facts?: { candidate_flow?: { sink_path?: string; source_path?: string; sink_class?: string } } };
  [key: string]: unknown;
};

export type ScanResponse = {
  skill_name: string;
  is_safe: boolean;
  max_severity: string;
  findings_count: number;
  findings: (RawFinding & {
    resolved_file: string | null;
    line_number: number | null;
    reported_line_number: number | null;
    line_inferred: boolean;
  })[];
};

// Runs the scan (local CLI or remote API, decided by SKILL_SCANNER_API_URL) and
// applies the same enrichment either way: resolving each finding's file_path
// against the caller's real file keys, correcting known line-attribution bugs via
// snippet matching, and inferring a line for network-flow findings that only
// carry file-level metadata.
export async function scanFiles(files: Record<string, string>): Promise<ScanResponse> {
  validateFiles(files);

  const apiUrl = process.env.SKILL_SCANNER_API_URL;
  if (!apiUrl && process.env.VERCEL) {
    throw new Error(
      "SKILL_SCANNER_API_URL is not set in this environment. There's no local Python CLI " +
        "to fall back to on Vercel — set it to the Render-hosted scanner's URL."
    );
  }
  const stdout = apiUrl ? await scanRemote(files, apiUrl) : await scanLocal(files);
  const result = JSON.parse(stdout);

  const byNormalizedKey = new Map<string, string>();
  for (const relPath of Object.keys(files)) {
    byNormalizedKey.set(normalizeKey(relPath), relPath);
  }

  const findings = (result.findings as RawFinding[]).map((f) => {
    const resolvedFile = f.file_path ? byNormalizedKey.get(normalizeKey(f.file_path)) ?? null : null;
    const reportedLine = f.line_number ?? null;
    const correctedLine =
      resolvedFile && files[resolvedFile]
        ? correctLineForSnippet(files[resolvedFile], f.snippet, reportedLine)
        : reportedLine;

    if (correctedLine != null) {
      return { ...f, resolved_file: resolvedFile, line_number: correctedLine, reported_line_number: reportedLine, line_inferred: false };
    }

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

  return { ...result, findings };
}
