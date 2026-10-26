import { NextResponse } from "next/server";
import JSZip from "jszip";

// Headroom above the fetch's own 180s timeout below.
export const maxDuration = 190;

// Wakes the Render-hosted scanner by actually running a (trivial) scan through
// the same code path a real one uses — not just a GET /health ping. A bare
// /health check wakes Render's dyno but never touches the Python process's own
// lazy-loaded pieces (YARA rule compilation, importing the litellm/Groq
// client), so it was reporting "warmed" well before a real scan actually was:
// observed directly, /health answering in seconds while a real scan still
// took 40+ more. This fires on page load (not on the user's first Scan click)
// so that cold-start time overlaps with them picking a file instead of
// happening after they've already committed to scanning.
//
// `remote` tells the client whether a Render-style cold start is even a
// concept here at all — false in local dev (no remote API configured,
// nothing to warm), true in production.
export async function GET() {
  const apiUrl = process.env.SKILL_SCANNER_API_URL;
  if (!apiUrl) return NextResponse.json({ remote: false, warmed: true });

  try {
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      "---\nname: warmup\ndescription: Internal warm-up ping, not a real skill.\n---\n\nNothing to see here.\n"
    );
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(zipBuffer)], { type: "application/zip" }), "warmup.zip");
    form.append("use_llm", "true");
    form.append("use_behavioral", "true");
    form.append("llm_provider", "openai-compatible");

    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/scan-upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    return NextResponse.json({ remote: true, warmed: res.ok });
  } catch {
    // Expected if it's still waking up past our own timeout — the point was
    // just to start that process as early as possible.
    return NextResponse.json({ remote: true, warmed: false });
  }
}
