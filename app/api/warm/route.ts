import { NextResponse } from "next/server";

// Fire-and-forget ping to wake the Render-hosted scanner before the user actually
// clicks Scan, so the ~60s free-tier cold start happens during page load instead
// of during their first real request. No-op locally (no remote API configured).
export async function GET() {
  const apiUrl = process.env.SKILL_SCANNER_API_URL;
  if (!apiUrl) return NextResponse.json({ warmed: false });

  try {
    await fetch(`${apiUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5_000) });
    return NextResponse.json({ warmed: true });
  } catch {
    // Expected while it's waking up — the point was just to start that process.
    return NextResponse.json({ warmed: false });
  }
}
