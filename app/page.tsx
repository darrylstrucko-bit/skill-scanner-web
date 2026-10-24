"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

type Finding = {
  id: string;
  rule_id: string;
  category: string;
  severity: Severity;
  title: string;
  description: string;
  file_path: string | null;
  resolved_file: string | null;
  line_number: number | null;
  reported_line_number: number | null;
  line_inferred: boolean;
  remediation: string | null;
};

type ScanResult = {
  skill_name: string;
  is_safe: boolean;
  max_severity: string;
  findings_count: number;
  findings: Finding[];
};

const PRESET_SKILLS = [
  { id: "benign-skill", label: "benign-skill (expected: clean)" },
  { id: "malicious-skill", label: "malicious-skill (expected: findings)" },
];

const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

const SEVERITY_BADGE: Record<Severity, string> = {
  CRITICAL: "bg-red-600 text-white",
  HIGH: "bg-orange-500 text-white",
  MEDIUM: "bg-yellow-400 text-black",
  LOW: "bg-blue-400 text-white",
  INFO: "bg-zinc-300 text-black",
};

const SEVERITY_LINE_BG: Record<Severity, string> = {
  CRITICAL: "bg-red-200/70 dark:bg-red-900/50",
  HIGH: "bg-orange-200/70 dark:bg-orange-900/40",
  MEDIUM: "bg-yellow-200/60 dark:bg-yellow-900/30",
  LOW: "bg-blue-200/50 dark:bg-blue-900/30",
  INFO: "bg-zinc-200/50 dark:bg-zinc-800/50",
};

function worstSeverity(findings: Finding[]): Severity {
  let best = SEVERITY_ORDER.length - 1;
  for (const f of findings) {
    const rank = SEVERITY_ORDER.indexOf(f.severity);
    if (rank >= 0 && rank < best) best = rank;
  }
  return SEVERITY_ORDER[best];
}

function lineKey(file: string, line: number) {
  return `${file}#${line}`;
}

// "preset": files always come fresh from /api/seed/<selected> on each Scan.
// "custom": files are whatever's in memory (an upload, or a preset with edits
// applied) — Scan re-sends them as-is instead of re-fetching the seed.
type Mode = "preset" | "custom";

export default function Home() {
  const [selected, setSelected] = useState(PRESET_SKILLS[0].id);
  const [mode, setMode] = useState<Mode>("preset");
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [customLabel, setCustomLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editsByLine, setEditsByLine] = useState<Record<number, string>>({});
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Keyed by finding.id — AI-suggested fixes are per-finding, requested on
  // demand, and don't touch the file until the user explicitly accepts one.
  const [suggestions, setSuggestions] = useState<
    Record<string, { status: "loading" | "done" | "error"; text?: string; error?: string }>
  >({});
  // "checking": waiting on the first /api/warm response. "cold": remote scanner
  // confirmed asleep — Scan stays disabled and we keep re-polling /api/warm until
  // it actually reports ready, rather than guessing a fixed wake time and
  // re-enabling on a timer (a guess that was wrong: enabling at a fixed T+60s
  // doesn't mean Render is actually done waking up yet). "warm": confirmed
  // awake, or there's no remote scanner at all (local dev).
  const [warmupState, setWarmupState] = useState<"checking" | "cold" | "warm">("checking");
  const [warmupElapsed, setWarmupElapsed] = useState(0);
  // Separate from warmupState so we can tell "genuinely confirmed awake" apart
  // from "gave up waiting, no idea" — only the former should rule out cold-start
  // as the explanation if a scan later runs long.
  const [isRemote, setIsRemote] = useState(false);
  // Timestamp of the last scan that actually completed against the remote
  // scanner — the only reliable "it's warm" signal (see note in checkWarm:
  // /api/warm's health ping isn't enough). Render spins down after ~15 min
  // idle, so a completion from 20 minutes ago isn't evidence it's still warm
  // now. Used to word the in-scan "taking a while" message honestly instead of
  // assuming either cause.
  const [lastKnownWarmAt, setLastKnownWarmAt] = useState<number | null>(null);

  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const fileHeaderRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const findingRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // Start waking the Render-hosted scanner as early as possible instead of
  // waiting for the user's first Scan click, and keep checking until it's
  // actually confirmed ready — not just "probably ready by now."
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout>;
    const pingStartedAt = Date.now();

    async function checkWarm() {
      try {
        const res = await fetch("/api/warm");
        const data = await res.json();
        if (cancelled) return;

        setIsRemote(Boolean(data.remote));

        if (!data.remote || data.warmed) {
          setWarmupState("warm");
          // Deliberately NOT updating lastKnownWarmAt here: /api/warm only pings
          // Render's lightweight /health route, which can respond before the
          // scanner's actual scan endpoint has finished cold-starting (observed
          // directly — /api/warm reported ready while a real scan still took
          // 40+ seconds). Only a scan that actually completes is trustworthy
          // evidence the full request path is warm.
          return;
        }

        const elapsed = Math.floor((Date.now() - pingStartedAt) / 1000);
        setWarmupElapsed(elapsed);
        setWarmupState("cold");

        // Give up waiting after a while and let them try anyway — the scan's own
        // 120s timeout and elapsed-time indicator take over from there. Note this
        // does NOT update lastKnownWarmAt — we're letting them proceed, not
        // claiming we know it's actually ready.
        if (elapsed < 90) {
          pollTimer = setTimeout(checkWarm, 4000);
        } else {
          setWarmupState("warm");
        }
      } catch {
        // Can't tell — don't block on a guess, but don't claim confirmation either.
        if (!cancelled) setWarmupState("warm");
      }
    }

    checkWarm();
    return () => {
      cancelled = true;
      clearTimeout(pollTimer);
    };
  }, []);

  const isWarmingUp = warmupState === "cold";

  // Fallback for while a scan is actually in flight (covers both the cold-start
  // case below and any other reason a scan runs long) — a visible counter instead
  // of a frozen "Scanning..." button.
  useEffect(() => {
    if (!loading) return;
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [loading]);

  async function runScanOn(targetFiles: Record<string, string>) {
    setLoading(true);
    setElapsedSeconds(0);
    setError(null);
    setSelectedFindingId(null);
    setEditingFile(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: targetFiles }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || data.error || "Scan failed");
      }
      setResult(data);
      // A completed scan is proof the server was up just now — refresh the
      // freshness window so a *later* slow scan isn't blamed on cold-start too.
      setLastKnownWarmAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleScanClick() {
    if (files) await runScanOn(files);
  }

  // Fetches and displays a preset's content immediately on selection, rather than
  // waiting for Scan — so there's actually something to look at when the UI calls
  // it "selected." Presets are read-only (nothing ever writes back to them), so
  // whatever we fetch here stays accurate until the user edits it, at which point
  // saveEdit switches mode to "custom" anyway.
  async function selectPreset(id: string) {
    setSelected(id);
    setMode("preset");
    setCustomLabel(null);
    setResult(null);
    setError(null);
    setFiles(null);
    try {
      const res = await fetch(`/api/seed/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load seed skill");
      setFiles(data.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Reset back to the idle state: header + selector only, architecture diagram
  // below. Does not touch warm-up state — the server staying awake has nothing
  // to do with what the user has loaded on screen.
  function clearAll() {
    setFiles(null);
    setResult(null);
    setError(null);
    setUploadError(null);
    setCustomLabel(null);
    setMode("preset");
    setSelectedFindingId(null);
    setEditingFile(null);
    setEditsByLine({});
    setSuggestions({});
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const entries: [string, string][] = [];
      for (const file of Array.from(fileList)) {
        const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        entries.push([relPath, await file.text()]);
      }
      const filesMap = Object.fromEntries(entries);
      setFiles(filesMap);
      setCustomLabel(entries.length === 1 ? entries[0][0] : `${entries.length} files`);
      setMode("custom");
      setResult(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  async function saveEdit() {
    if (!editingFile || !files) return;
    const originalLines = files[editingFile].split("\n");
    const content = originalLines.map((lineText, idx) => editsByLine[idx + 1] ?? lineText).join("\n");
    const updatedFiles = { ...files, [editingFile]: content };
    setFiles(updatedFiles);
    setMode("custom");
    if (!customLabel) {
      const presetLabel = PRESET_SKILLS.find((s) => s.id === selected)?.label ?? selected;
      setCustomLabel(`${presetLabel} (edited)`);
    }
    await runScanOn(updatedFiles);
  }

  async function requestSuggestion(f: Finding) {
    if (!f.resolved_file || f.line_number == null || !files) return;
    setSuggestions((prev) => ({ ...prev, [f.id]: { status: "loading" } }));
    try {
      const res = await fetch("/api/suggest-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileContent: files[f.resolved_file],
          fileName: f.resolved_file,
          lineNumber: f.line_number,
          findingTitle: f.title,
          findingDescription: f.description,
          remediation: f.remediation,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Suggestion failed");
      setSuggestions((prev) => ({ ...prev, [f.id]: { status: "done", text: data.suggestion } }));
    } catch (err) {
      setSuggestions((prev) => ({
        ...prev,
        [f.id]: { status: "error", error: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  // Applies the suggestion into the normal per-line edit mechanism (same slot
  // manual edits use) rather than saving directly — the user still reviews it in
  // context and clicks Save & rescan themselves before it goes anywhere.
  function acceptSuggestion(f: Finding) {
    if (!f.resolved_file || f.line_number == null) return;
    const suggestion = suggestions[f.id];
    if (!suggestion || suggestion.status !== "done" || suggestion.text == null) return;
    const line = f.line_number;
    const text = suggestion.text;
    setEditsByLine((prev) => (editingFile === f.resolved_file ? { ...prev, [line]: text } : { [line]: text }));
    setEditingFile(f.resolved_file);
    setSuggestions((prev) => {
      const next = { ...prev };
      delete next[f.id];
      return next;
    });
    selectFinding(f);
  }

  function dismissSuggestion(f: Finding) {
    setSuggestions((prev) => {
      const next = { ...prev };
      delete next[f.id];
      return next;
    });
  }

  // file -> line -> findings on that line
  const lineIndex = useMemo(() => {
    const idx = new Map<string, Map<number, Finding[]>>();
    if (!result) return idx;
    for (const f of result.findings) {
      if (!f.resolved_file || f.line_number == null) continue;
      if (!idx.has(f.resolved_file)) idx.set(f.resolved_file, new Map());
      const fileMap = idx.get(f.resolved_file)!;
      if (!fileMap.has(f.line_number)) fileMap.set(f.line_number, []);
      fileMap.get(f.line_number)!.push(f);
    }
    return idx;
  }, [result]);

  // file -> findings with no specific line (manifest/file-level issues)
  const fileLevelFindings = useMemo(() => {
    const idx = new Map<string, Finding[]>();
    if (!result) return idx;
    for (const f of result.findings) {
      if (!f.resolved_file || f.line_number != null) continue;
      if (!idx.has(f.resolved_file)) idx.set(f.resolved_file, []);
      idx.get(f.resolved_file)!.push(f);
    }
    return idx;
  }, [result]);

  const findingsPerFile = useMemo(() => {
    const idx = new Map<string, number>();
    if (!result) return idx;
    for (const f of result.findings) {
      if (!f.resolved_file) continue;
      idx.set(f.resolved_file, (idx.get(f.resolved_file) ?? 0) + 1);
    }
    return idx;
  }, [result]);

  const orphanFindings = useMemo(
    () => (result ? result.findings.filter((f) => !f.resolved_file) : []),
    [result]
  );

  useEffect(() => {
    if (!selectedFindingId || !result) return;
    const f = result.findings.find((x) => x.id === selectedFindingId);
    if (!f || !f.resolved_file) return;
    const target =
      f.line_number != null
        ? lineRefs.current[lineKey(f.resolved_file, f.line_number)]
        : fileHeaderRefs.current[f.resolved_file];
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selectedFindingId, result]);

  function selectFinding(f: Finding) {
    setSelectedFindingId(f.id);
    requestAnimationFrame(() => {
      findingRefs.current[f.id]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  function selectLine(file: string, line: number) {
    const findings = lineIndex.get(file)?.get(line);
    if (!findings || findings.length === 0) return;
    const currentIdx = findings.findIndex((f) => f.id === selectedFindingId);
    const next = findings[(currentIdx + 1) % findings.length];
    selectFinding(next);
  }

  const sortedFindings = useMemo(() => {
    if (!result) return [];
    return [...result.findings].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    );
  }, [result]);

  const displayFiles = files ?? {};

  // Render spins down after ~15 min idle; trust a warm confirmation for 10 min
  // (safety margin) before treating the server's current state as unknown again.
  const recentlyWarm =
    lastKnownWarmAt != null && Date.now() - lastKnownWarmAt < 10 * 60 * 1000;

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-8 font-sans dark:bg-black">
      <main className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/app-logo.svg" alt="Skill Scanner logo" className="mt-0.5 h-9 w-9 shrink-0" />
          <div>
            <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
              Skill Scanner
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Choose a skill file and run it through the Skill Scanner to detect
              malicious patterns and prevent prompt injection and data exfiltration.
              <br />
              Review findings and edit using this interface.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            {PRESET_SKILLS.map((s) => (
              <button
                key={s.id}
                onClick={() => selectPreset(s.id)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === "preset" && selected === s.id
                    ? "bg-violet-700 text-white"
                    : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <button
            onClick={handleScanClick}
            disabled={loading || isWarmingUp || !files}
            className="rounded bg-violet-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-800 active:bg-violet-900 disabled:opacity-50 dark:bg-violet-500 dark:hover:bg-violet-400 dark:active:bg-violet-300"
          >
            {loading ? `Scanning... ${elapsedSeconds}s` : "Scan"}
          </button>

          <div className="flex items-center gap-2 border-l border-zinc-300 pl-3 dark:border-zinc-700">
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              accept=".md,.py,.js,.ts,.json,.yaml,.yml,.txt,.sh"
              onChange={handleUpload}
              disabled={uploading}
              className="text-xs text-zinc-700 file:mr-2 file:cursor-pointer file:rounded file:border file:border-zinc-400 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-black file:transition-colors hover:file:bg-zinc-100 active:file:bg-zinc-200 disabled:opacity-50 dark:text-zinc-300 dark:file:border-zinc-600 dark:file:bg-zinc-900 dark:file:text-zinc-100 dark:hover:file:bg-zinc-800 dark:active:file:bg-zinc-700"
            />
            {uploading && <span className="text-xs text-zinc-500">Reading files...</span>}
          </div>

          {(files || result) && (
            <button
              onClick={clearAll}
              className="rounded border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 active:bg-zinc-200 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
            >
              Clear
            </button>
          )}

          {mode === "custom" && customLabel && (
            <div className="flex items-center gap-1.5 rounded border border-violet-300 bg-violet-50 px-2.5 py-1.5 text-xs font-medium text-violet-800 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-300">
              <span className="text-violet-500 dark:text-violet-500">Selected:</span>
              <span className="font-mono">{customLabel}</span>
            </div>
          )}

          {isWarmingUp && (
            <span className="max-w-xs rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs leading-snug text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              Server is starting up (not scanning yet) — {warmupElapsed}s so far, usually
              under a minute.
            </span>
          )}
          {loading && elapsedSeconds >= 8 && (
            <span className="max-w-xs rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs leading-snug text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {isRemote && !recentlyWarm
                ? "Still going — most likely the server is still finishing its wake-up from idle, not the scan itself (can take up to ~2 minutes in rare cases)."
                : "Still scanning — this skill is just taking longer (larger or more complex files take more time)."}
            </span>
          )}

          {result && (
            <div className="flex items-center gap-2">
              <span
                className={`rounded px-2 py-1 text-xs font-semibold ${
                  result.is_safe ? "bg-green-600 text-white" : "bg-red-600 text-white"
                }`}
              >
                {result.is_safe ? "SAFE" : "ISSUES FOUND"}
              </span>
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                {result.skill_name} — max severity {result.max_severity}, {result.findings_count}{" "}
                finding{result.findings_count === 1 ? "" : "s"}
              </span>
            </div>
          )}
        </div>

        {uploadError && (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            Upload failed: {uploadError}
          </div>
        )}
        {error && (
          <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {!files && (
          <div className="flex flex-col items-center gap-4 rounded border border-dashed border-zinc-300 py-10 dark:border-zinc-700">
            <p className="text-sm text-zinc-500 dark:text-zinc-500">
              Pick a preset chip or choose a file above to load it for scanning.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/skill-scanner-arch2.png"
              alt="Architecture diagram: the Vercel-hosted Next.js web app calls Render, which runs Cisco's open-source Skill Scanner, and Groq, which suggests fixes using Alibaba Qwen 3.8"
              className="w-full max-w-xl"
            />
          </div>
        )}

        {files && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            {/* Source panel: all files stacked in one continuous scroll, no tabs */}
            <div className="flex flex-col gap-4 overflow-auto lg:col-span-3 lg:max-h-[calc(100vh-220px)]">
              {Object.keys(displayFiles).map((file) => {
                const issueCount = findingsPerFile.get(file) ?? 0;
                const isEditing = editingFile === file;
                return (
                  <div
                    key={file}
                    className="overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <div
                      ref={(el) => {
                        fileHeaderRefs.current[file] = el;
                      }}
                      className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-violet-200 bg-violet-50 px-3 py-2 dark:border-violet-900 dark:bg-violet-950/40"
                    >
                      <span className="font-mono text-xs font-semibold text-black dark:text-zinc-50">
                        {file}
                        {issueCount > 0 && (
                          <span className="ml-2 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] text-white">
                            {issueCount} issue{issueCount === 1 ? "" : "s"}
                          </span>
                        )}
                      </span>
                      {result &&
                        (isEditing ? (
                          <div className="flex gap-2">
                            <button
                              onClick={saveEdit}
                              className="rounded bg-violet-700 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-violet-800 active:bg-violet-900 dark:bg-violet-500 dark:hover:bg-violet-400 dark:active:bg-violet-300"
                            >
                              Save &amp; rescan
                            </button>
                            <button
                              onClick={() => setEditingFile(null)}
                              className="rounded border border-violet-300 px-2 py-1 text-xs transition-colors hover:bg-violet-50 active:bg-violet-100 dark:border-violet-800 dark:hover:bg-violet-950/40 dark:active:bg-violet-900/40"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              setEditingFile(file);
                              setEditsByLine({});
                            }}
                            className="rounded border border-violet-300 px-2 py-1 text-xs transition-colors hover:bg-violet-50 active:bg-violet-100 dark:border-violet-800 dark:hover:bg-violet-950/40 dark:active:bg-violet-900/40"
                          >
                            Edit
                          </button>
                        ))}
                    </div>

                    {fileLevelFindings.get(file) && (
                      <div className="flex flex-col gap-1 p-2">
                        {fileLevelFindings.get(file)!.map((f) => (
                          <button
                            key={f.id}
                            onClick={() => selectFinding(f)}
                            className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:brightness-95 active:brightness-90 dark:hover:brightness-110 dark:active:brightness-125 ${
                              SEVERITY_LINE_BG[f.severity]
                            } ${selectedFindingId === f.id ? "ring-2 ring-inset ring-violet-500 dark:ring-violet-400" : ""}`}
                          >
                            <span className={`rounded px-1.5 py-0.5 font-semibold ${SEVERITY_BADGE[f.severity]}`}>
                              {f.severity}
                            </span>
                            <span className="text-black dark:text-zinc-100">
                              {f.title} — {f.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}

                    {isEditing && (
                      <p className="border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-500">
                        Flagged lines are editable below — everything else is read-only in
                        this view.
                      </p>
                    )}
                    <div className="font-mono text-xs leading-5">
                      {displayFiles[file].split("\n").map((lineText, idx) => {
                        const lineNum = idx + 1;
                        const findingsOnLine = lineIndex.get(file)?.get(lineNum) ?? [];
                        const hasIssue = findingsOnLine.length > 0;
                        const isSelected = findingsOnLine.some((f) => f.id === selectedFindingId);
                        const bg = hasIssue ? SEVERITY_LINE_BG[worstSeverity(findingsOnLine)] : "";
                        const isLineEditing = isEditing && hasIssue;
                        return (
                          <div
                            key={lineNum}
                            ref={(el) => {
                              lineRefs.current[lineKey(file, lineNum)] = el;
                            }}
                            onClick={() => !isEditing && hasIssue && selectLine(file, lineNum)}
                            className={`flex px-2 ${bg} ${hasIssue && !isEditing ? "cursor-pointer" : ""} ${
                              isSelected ? "ring-2 ring-inset ring-violet-500 dark:ring-violet-400" : ""
                            }`}
                            title={hasIssue ? findingsOnLine.map((f) => f.title).join("; ") : undefined}
                          >
                            <span className="w-8 shrink-0 select-none text-right text-zinc-400">
                              {lineNum}
                            </span>
                            {isLineEditing ? (
                              <input
                                value={editsByLine[lineNum] ?? lineText}
                                onChange={(e) =>
                                  setEditsByLine((prev) => ({ ...prev, [lineNum]: e.target.value }))
                                }
                                onClick={(e) => e.stopPropagation()}
                                spellCheck={false}
                                className="ml-3 flex-1 border-0 bg-transparent font-mono text-xs text-black outline-none dark:text-zinc-100"
                              />
                            ) : (
                              <span className="ml-3 whitespace-pre-wrap text-black dark:text-zinc-100">
                                {lineText || " "}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Findings panel */}
            <div className="flex flex-col gap-2 overflow-auto lg:col-span-2 lg:max-h-[calc(100vh-220px)]">
              {!result && (
                <div className="rounded border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-500">
                  Source loaded — click <span className="font-medium">Scan</span> to check
                  it for issues.
                </div>
              )}
              {sortedFindings.map((f) => (
                <div
                  key={f.id}
                  ref={(el) => {
                    findingRefs.current[f.id] = el;
                  }}
                  onClick={() => selectFinding(f)}
                  className={`cursor-pointer rounded border bg-white p-4 transition-colors hover:bg-zinc-50 active:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 dark:active:bg-zinc-700 ${
                    selectedFindingId === f.id
                      ? "border-violet-500 dark:border-violet-400"
                      : "border-zinc-200 dark:border-zinc-800"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${SEVERITY_BADGE[f.severity]}`}>
                      {f.severity}
                    </span>
                    <span className="text-sm font-medium text-black dark:text-zinc-50">
                      {f.title}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{f.description}</p>
                  {f.resolved_file && (
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                      {f.resolved_file}
                      {f.line_number ? `:${f.line_number}` : " (file-level)"}
                      {f.line_number != null &&
                        f.reported_line_number != null &&
                        f.reported_line_number !== f.line_number && (
                          <span className="ml-1 text-amber-600 dark:text-amber-500">
                            (scanner reported line {f.reported_line_number}, corrected by
                            text match)
                          </span>
                        )}
                      {f.line_inferred && (
                        <span className="ml-1 text-amber-600 dark:text-amber-500">
                          (location inferred from related code)
                        </span>
                      )}
                    </p>
                  )}
                  {f.remediation && (
                    <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                      Suggested fix: {f.remediation}
                    </p>
                  )}
                  {f.resolved_file && f.line_number != null && (
                    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                      {!suggestions[f.id] && (
                        <button
                          onClick={() => requestSuggestion(f)}
                          className="rounded border border-violet-300 px-2 py-1 text-xs transition-colors hover:bg-violet-50 active:bg-violet-100 dark:border-violet-800 dark:hover:bg-violet-950/40 dark:active:bg-violet-900/40"
                        >
                          Suggest a fix (AI)
                        </button>
                      )}
                      {suggestions[f.id]?.status === "loading" && (
                        <span className="text-xs text-zinc-500 dark:text-zinc-500">
                          Asking Groq...
                        </span>
                      )}
                      {suggestions[f.id]?.status === "error" && (
                        <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
                          <span>{suggestions[f.id]?.error}</span>
                          <button
                            onClick={() => requestSuggestion(f)}
                            className="rounded border border-red-300 px-2 py-0.5 dark:border-red-800"
                          >
                            Retry
                          </button>
                        </div>
                      )}
                      {suggestions[f.id]?.status === "done" && (
                        <div className="rounded border border-violet-300 bg-violet-50 p-2 dark:border-violet-800 dark:bg-violet-950/40">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-violet-500 dark:text-violet-400">
                            Current
                          </p>
                          <p className="truncate font-mono text-xs text-zinc-500 line-through decoration-red-400 dark:text-zinc-500">
                            {files?.[f.resolved_file]?.split("\n")[f.line_number - 1]}
                          </p>
                          <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-violet-500 dark:text-violet-400">
                            Suggested
                          </p>
                          <p className="whitespace-pre-wrap font-mono text-xs text-black dark:text-zinc-100">
                            {suggestions[f.id]?.text}
                          </p>
                          <div className="mt-2 flex gap-2">
                            <button
                              onClick={() => acceptSuggestion(f)}
                              className="rounded bg-violet-700 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-violet-800 active:bg-violet-900 dark:bg-violet-500 dark:hover:bg-violet-400 dark:active:bg-violet-300"
                            >
                              Accept
                            </button>
                            <button
                              onClick={() => dismissSuggestion(f)}
                              className="rounded border border-violet-300 px-2 py-1 text-xs transition-colors hover:bg-violet-100 dark:border-violet-800 dark:hover:bg-violet-900/40"
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {orphanFindings.length > 0 && (
                <div className="rounded border border-dashed border-zinc-300 p-3 text-xs text-zinc-500 dark:border-zinc-700">
                  {orphanFindings.length} finding(s) couldn&apos;t be matched to a source
                  file shown above.
                </div>
              )}
            </div>
          </div>
        )}

        <footer className="mt-4 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
          Powered by{" "}
          <a
            href="https://github.com/cisco-ai-defense/skill-scanner"
            target="_blank"
            rel="noopener noreferrer"
            className="text-violet-600 underline hover:text-violet-800 dark:text-violet-400 dark:hover:text-violet-300"
          >
            Cisco&apos;s open-source Skill Scanner
          </a>{" "}
          (Apache-2.0).
        </footer>
      </main>
    </div>
  );
}
