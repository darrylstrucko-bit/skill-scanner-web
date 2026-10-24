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
  label: string;
  is_safe: boolean;
  max_severity: string;
  findings_count: number;
  findings: Finding[];
  files: Record<string, string>;
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

export default function Home() {
  const [customSkills, setCustomSkills] = useState<{ id: string; label: string }[]>([]);
  const [selected, setSelected] = useState(PRESET_SKILLS[0].id);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState("");

  const lineRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const fileHeaderRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const findingRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  async function runScan(skillId: string) {
    setLoading(true);
    setError(null);
    setSelectedFindingId(null);
    setEditingFile(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || data.error || "Scan failed");
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("count", String(fileList.length));
      Array.from(fileList).forEach((file, i) => {
        const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        form.append(`path_${i}`, relPath);
        form.append(`file_${i}`, file);
      });
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || data.error || "Upload failed");
      }
      setCustomSkills((prev) => [...prev, { id: data.skillId, label: `${data.label} (uploaded)` }]);
      setSelected(data.skillId);
      await runScan(data.skillId);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  async function saveEdit() {
    if (!editingFile || !result) return;
    try {
      const res = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: selected, file: editingFile, content: editBuffer }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || data.error || "Save failed");
      }
      await runScan(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  const allSkillOptions = [...PRESET_SKILLS, ...customSkills];

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-8 font-sans dark:bg-black">
      <main className="mx-auto flex max-w-6xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Skill Scanner — Phase 1 (local, unprotected)
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Click a finding to jump to it in the source, or click a highlighted line to
            see why it was flagged. Uploaded skills are written to a local temp folder
            for this session only — no sandboxing yet, that&apos;s phase 2.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {allSkillOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => runScan(selected)}
            disabled={loading}
            className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-black"
          >
            {loading ? "Scanning..." : "Scan"}
          </button>

          <div className="flex items-center gap-2 border-l border-zinc-300 pl-3 dark:border-zinc-700">
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              onChange={handleUpload}
              disabled={uploading}
              {...({ webkitdirectory: "true", directory: "true" } as Record<string, string>)}
              className="text-xs text-zinc-600 file:mr-2 file:rounded file:border-0 file:bg-zinc-200 file:px-3 file:py-1.5 file:text-xs file:font-medium dark:text-zinc-400 dark:file:bg-zinc-800 dark:file:text-zinc-100"
            />
            {uploading && <span className="text-xs text-zinc-500">Uploading &amp; scanning...</span>}
          </div>

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
                {result.label} — max severity {result.max_severity}, {result.findings_count}{" "}
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

        {result && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            {/* Source panel: all files stacked in one continuous scroll, no tabs */}
            <div className="flex flex-col gap-4 overflow-auto lg:col-span-3 lg:max-h-[calc(100vh-220px)]">
              {Object.keys(result.files).map((file) => {
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
                      className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-100 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950"
                    >
                      <span className="font-mono text-xs font-semibold text-black dark:text-zinc-50">
                        {file}
                        {issueCount > 0 && (
                          <span className="ml-2 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] text-white">
                            {issueCount} issue{issueCount === 1 ? "" : "s"}
                          </span>
                        )}
                      </span>
                      {isEditing ? (
                        <div className="flex gap-2">
                          <button
                            onClick={saveEdit}
                            className="rounded bg-black px-2 py-1 text-xs font-medium text-white dark:bg-zinc-50 dark:text-black"
                          >
                            Save &amp; rescan
                          </button>
                          <button
                            onClick={() => setEditingFile(null)}
                            className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setEditingFile(file);
                            setEditBuffer(result.files[file]);
                          }}
                          className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700"
                        >
                          Edit
                        </button>
                      )}
                    </div>

                    {fileLevelFindings.get(file) && (
                      <div className="flex flex-col gap-1 p-2">
                        {fileLevelFindings.get(file)!.map((f) => (
                          <button
                            key={f.id}
                            onClick={() => selectFinding(f)}
                            className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${SEVERITY_LINE_BG[f.severity]}`}
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

                    {isEditing ? (
                      <textarea
                        value={editBuffer}
                        onChange={(e) => setEditBuffer(e.target.value)}
                        className="h-80 w-full resize-y border-0 bg-white p-3 font-mono text-xs text-black outline-none dark:bg-zinc-900 dark:text-zinc-100"
                        spellCheck={false}
                      />
                    ) : (
                      <div className="overflow-x-auto font-mono text-xs leading-5">
                        {result.files[file].split("\n").map((lineText, idx) => {
                          const lineNum = idx + 1;
                          const findingsOnLine = lineIndex.get(file)?.get(lineNum) ?? [];
                          const hasIssue = findingsOnLine.length > 0;
                          const isSelected = findingsOnLine.some((f) => f.id === selectedFindingId);
                          const bg = hasIssue ? SEVERITY_LINE_BG[worstSeverity(findingsOnLine)] : "";
                          return (
                            <div
                              key={lineNum}
                              ref={(el) => {
                                lineRefs.current[lineKey(file, lineNum)] = el;
                              }}
                              onClick={() => hasIssue && selectLine(file, lineNum)}
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
                    )}
                  </div>
                );
              })}
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

        <footer className="mt-4 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
          Powered by{" "}
          <a
            href="https://github.com/cisco-ai-defense/skill-scanner"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Cisco&apos;s open-source Skill Scanner
          </a>{" "}
          (Apache-2.0).
        </footer>
      </main>
    </div>
  );
}
