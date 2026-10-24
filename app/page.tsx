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
  remediation: string | null;
};

type ScanResult = {
  skill_name: string;
  is_safe: boolean;
  max_severity: string;
  findings_count: number;
  findings: Finding[];
  files: Record<string, string>;
};

const SAMPLE_SKILLS = [
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

export default function Home() {
  const [selected, setSelected] = useState(SAMPLE_SKILLS[0].id);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);

  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const findingRefs = useRef<Record<string, HTMLDivElement | null>>({});

  async function runScan() {
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedFindingId(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: selected }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || data.error || "Scan failed");
      }
      setResult(data);
      const firstFile = Object.keys(data.files)[0] ?? null;
      setActiveFile(
        Object.keys(data.files).find((f) => f.toLowerCase() === "skill.md") ?? firstFile
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
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

  const orphanFindings = useMemo(
    () => (result ? result.findings.filter((f) => !f.resolved_file) : []),
    [result]
  );

  // Jump the source panel to the selected finding's line whenever selection or file changes.
  useEffect(() => {
    if (!selectedFindingId) return;
    const el = lineRefs.current[getSelectedLine()];
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFindingId, activeFile]);

  function getSelectedLine(): number {
    const f = result?.findings.find((x) => x.id === selectedFindingId);
    return f?.line_number ?? -1;
  }

  function selectFinding(f: Finding) {
    setSelectedFindingId(f.id);
    if (f.resolved_file && f.resolved_file !== activeFile) {
      setActiveFile(f.resolved_file);
    }
    requestAnimationFrame(() => {
      findingRefs.current[f.id]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  function selectLine(file: string, line: number) {
    const findings = lineIndex.get(file)?.get(line);
    if (!findings || findings.length === 0) return;
    // Cycle through findings on the same line on repeated clicks.
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

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-8 font-sans dark:bg-black">
      <main className="mx-auto flex max-w-6xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Skill Scanner — Phase 1 (local, unprotected)
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Scans a fixed set of local sample skills with Cisco&apos;s open-source Skill
            Scanner. Click a finding to jump to it in the source, or click a highlighted
            line to see why it was flagged. No uploads, no sandboxing yet — that&apos;s
            phase 2.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {SAMPLE_SKILLS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            onClick={runScan}
            disabled={loading}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
          >
            {loading ? "Scanning..." : "Scan"}
          </button>
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

        {error && (
          <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {result && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            {/* Source panel */}
            <div className="flex flex-col overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 lg:col-span-3">
              <div className="flex gap-1 border-b border-zinc-200 bg-zinc-100 px-2 pt-2 dark:border-zinc-800 dark:bg-zinc-950">
                {Object.keys(result.files).map((file) => {
                  const issueCount =
                    (lineIndex.get(file)?.size ?? 0) > 0 || (fileLevelFindings.get(file)?.length ?? 0) > 0
                      ? [...(result.findings ?? [])].filter((f) => f.resolved_file === file).length
                      : 0;
                  return (
                    <button
                      key={file}
                      onClick={() => setActiveFile(file)}
                      className={`rounded-t px-3 py-2 text-xs font-mono ${
                        activeFile === file
                          ? "bg-white text-black dark:bg-zinc-900 dark:text-zinc-50"
                          : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
                      }`}
                    >
                      {file}
                      {issueCount > 0 && (
                        <span className="ml-1.5 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] text-white">
                          {issueCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {activeFile && fileLevelFindings.get(activeFile) && (
                <div className="flex flex-col gap-1 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
                  {fileLevelFindings.get(activeFile)!.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => selectFinding(f)}
                      className="flex items-center gap-2 text-left text-xs"
                    >
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${SEVERITY_BADGE[f.severity]}`}>
                        {f.severity}
                      </span>
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {f.title} (file-level, no specific line)
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <div className="overflow-auto font-mono text-xs leading-5">
                {activeFile &&
                  result.files[activeFile].split("\n").map((lineText, idx) => {
                    const lineNum = idx + 1;
                    const findingsOnLine = lineIndex.get(activeFile)?.get(lineNum) ?? [];
                    const hasIssue = findingsOnLine.length > 0;
                    const isSelected = findingsOnLine.some((f) => f.id === selectedFindingId);
                    const bg = hasIssue ? SEVERITY_LINE_BG[worstSeverity(findingsOnLine)] : "";
                    return (
                      <div
                        key={lineNum}
                        ref={(el) => {
                          if (isSelected) lineRefs.current[lineNum] = el;
                        }}
                        onClick={() => hasIssue && selectLine(activeFile, lineNum)}
                        className={`flex px-2 ${bg} ${hasIssue ? "cursor-pointer" : ""} ${
                          isSelected ? "ring-2 ring-inset ring-black dark:ring-white" : ""
                        }`}
                        title={hasIssue ? findingsOnLine.map((f) => f.title).join("; ") : undefined}
                      >
                        <span className="w-8 shrink-0 select-none text-right text-zinc-400">
                          {lineNum}
                        </span>
                        <span className="ml-3 whitespace-pre-wrap text-black dark:text-zinc-100">
                          {lineText || " "}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* Findings panel */}
            <div className="flex flex-col gap-2 overflow-auto lg:col-span-2 lg:max-h-[calc(100vh-220px)]">
              {sortedFindings.map((f) => (
                <div
                  key={f.id}
                  ref={(el) => {
                    findingRefs.current[f.id] = el;
                  }}
                  onClick={() => selectFinding(f)}
                  className={`cursor-pointer rounded border bg-white p-4 dark:bg-zinc-900 ${
                    selectedFindingId === f.id
                      ? "border-black dark:border-white"
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
                    </p>
                  )}
                  {f.remediation && (
                    <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                      Suggested fix: {f.remediation}
                    </p>
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
      </main>
    </div>
  );
}
