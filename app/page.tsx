"use client";

import { useState } from "react";

type Finding = {
  id: string;
  rule_id: string;
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  title: string;
  description: string;
  file_path: string | null;
  line_number: number | null;
  remediation: string | null;
};

type ScanResult = {
  skill_name: string;
  is_safe: boolean;
  max_severity: string;
  findings_count: number;
  findings: Finding[];
};

const SAMPLE_SKILLS = [
  { id: "benign-skill", label: "benign-skill (expected: clean)" },
  { id: "malicious-skill", label: "malicious-skill (expected: findings)" },
];

const SEVERITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-600 text-white",
  HIGH: "bg-orange-500 text-white",
  MEDIUM: "bg-yellow-400 text-black",
  LOW: "bg-blue-400 text-white",
  INFO: "bg-zinc-300 text-black",
};

export default function Home() {
  const [selected, setSelected] = useState(SAMPLE_SKILLS[0].id);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runScan() {
    setLoading(true);
    setError(null);
    setResult(null);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-12 font-sans dark:bg-black">
      <main className="mx-auto flex max-w-3xl flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Skill Scanner — Phase 1 (local, unprotected)
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Scans a fixed set of local sample skills with Cisco&apos;s open-source
            Skill Scanner. No uploads, no sandboxing yet — that&apos;s phase 2.
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
        </div>

        {error && (
          <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
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

            <div className="flex flex-col gap-2">
              {result.findings.map((f) => (
                <div
                  key={f.id}
                  className="rounded border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-semibold ${
                        SEVERITY_STYLES[f.severity] ?? "bg-zinc-300 text-black"
                      }`}
                    >
                      {f.severity}
                    </span>
                    <span className="text-sm font-medium text-black dark:text-zinc-50">
                      {f.title}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                    {f.description}
                  </p>
                  {f.file_path && (
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                      {f.file_path}
                      {f.line_number ? `:${f.line_number}` : ""}
                    </p>
                  )}
                  {f.remediation && (
                    <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                      Remediation: {f.remediation}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
