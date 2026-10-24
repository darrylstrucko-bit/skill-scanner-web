import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { registerUpload, UPLOADS_ROOT } from "@/lib/skillRegistry";
import { TEXT_EXTENSIONS } from "@/lib/skillFiles";

const MAX_FILES = 50;
const MAX_FILE_BYTES = 512 * 1024; // 512KB per file
const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5MB total

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const count = Number(form.get("count"));
  if (!Number.isInteger(count) || count < 1 || count > MAX_FILES) {
    return NextResponse.json(
      { error: `Must upload between 1 and ${MAX_FILES} files.` },
      { status: 400 }
    );
  }

  type Entry = { relPath: string; blob: File };
  const entries: Entry[] = [];
  let totalBytes = 0;

  for (let i = 0; i < count; i++) {
    const relPath = form.get(`path_${i}`);
    const blob = form.get(`file_${i}`);
    if (typeof relPath !== "string" || !(blob instanceof File)) {
      return NextResponse.json({ error: `Malformed entry ${i}` }, { status: 400 });
    }

    // Reject path traversal and absolute paths outright.
    const segments = relPath.split("/");
    if (relPath.startsWith("/") || segments.includes("..") || segments.includes(".")) {
      return NextResponse.json({ error: `Unsafe path: ${relPath}` }, { status: 400 });
    }

    const ext = path.extname(relPath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${relPath} (only text/skill files are accepted)` },
        { status: 400 }
      );
    }

    if (blob.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: `File too large: ${relPath}` }, { status: 400 });
    }
    totalBytes += blob.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: "Upload exceeds total size limit." }, { status: 400 });
    }

    entries.push({ relPath, blob });
  }

  // If every path shares the same first segment (the picked folder's name), strip it
  // so the uploaded skill's files land directly at the new skill root.
  const firstSegments = new Set(entries.map((e) => e.relPath.split("/")[0]));
  const commonPrefix = firstSegments.size === 1 ? [...firstSegments][0] : null;
  const label = commonPrefix ?? "uploaded-skill";

  const rawId = randomUUID();
  const skillId = `upload:${rawId}`;
  const uploadDir = path.join(UPLOADS_ROOT, rawId);

  try {
    await fs.mkdir(uploadDir, { recursive: true });
    for (const { relPath, blob } of entries) {
      const strippedPath = commonPrefix
        ? relPath.slice(commonPrefix.length + 1)
        : relPath;
      if (!strippedPath) continue;
      const targetPath = path.join(uploadDir, ...strippedPath.split("/"));
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const buf = Buffer.from(await blob.arrayBuffer());
      await fs.writeFile(targetPath, buf);
    }

    registerUpload(skillId, uploadDir, label);
    return NextResponse.json({ skillId, label });
  } catch (err) {
    return NextResponse.json(
      { error: "Upload failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
