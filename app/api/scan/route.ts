import { NextResponse } from "next/server";
import { scanFiles, ScanInputError } from "@/lib/scanBackend";

// Headroom above scanRemote's own 90s fetch timeout, so Vercel's platform-level
// limit (300s default on Hobby) never kills the function before our own timeout
// has a chance to fire with a clear error.
export const maxDuration = 100;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const files = body?.files;

  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return NextResponse.json({ error: "Missing files." }, { status: 400 });
  }
  for (const [name, content] of Object.entries(files)) {
    if (typeof name !== "string" || typeof content !== "string") {
      return NextResponse.json({ error: "files must be a map of path -> text content." }, { status: 400 });
    }
  }

  try {
    const result = await scanFiles(files);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ScanInputError) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    return NextResponse.json(
      { error: "Scan failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
