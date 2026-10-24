import { NextResponse } from "next/server";

// Fire-and-forget ping to wake the Render-hosted scanner before the user actually
// clicks Scan, so the ~60s free-tier cold start happens during page load instead
// of during their first real request.
//
// `remote` tells the client whether a Render-style cold start is even a concept
// here at all — false in local dev (no remote API configured, nothing to warm),
// true in production. Only check `warmed` when `remote` is true.
export async function GET() {
  const apiUrl = process.env.SKILL_SCANNER_API_URL;
  if (!apiUrl) return NextResponse.json({ remote: false, warmed: true });

  try {
    await fetch(`${apiUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5_000) });
    return NextResponse.json({ remote: true, warmed: true });
  } catch {
    // Expected while it's waking up — the point was just to start that process.
    return NextResponse.json({ remote: true, warmed: false });
  }
}
