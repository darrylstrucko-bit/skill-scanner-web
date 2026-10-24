import { NextResponse } from "next/server";

export const maxDuration = 30;

const GROQ_MODEL = "llama-3.3-70b-versatile";

export async function POST(request: Request) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GROQ_API_KEY is not configured." }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  const fileContent = body?.fileContent;
  const fileName = body?.fileName;
  const lineNumber = body?.lineNumber;
  const findingTitle = body?.findingTitle;
  const findingDescription = body?.findingDescription;
  const remediation = body?.remediation;

  if (typeof fileContent !== "string" || typeof fileName !== "string" || typeof lineNumber !== "number") {
    return NextResponse.json({ error: "Missing fileContent, fileName, or lineNumber." }, { status: 400 });
  }

  const lines = fileContent.split("\n");
  const flaggedLine = lines[lineNumber - 1];
  if (flaggedLine == null) {
    return NextResponse.json({ error: "lineNumber out of range for fileContent." }, { status: 400 });
  }

  const userPrompt = [
    `File: ${fileName}`,
    "",
    "Full file content, for context:",
    "```",
    fileContent,
    "```",
    "",
    `The flagged line is line ${lineNumber}:`,
    flaggedLine,
    "",
    `Finding: ${findingTitle ?? "unknown"}`,
    findingDescription ? `Description: ${findingDescription}` : "",
    remediation ? `Scanner's suggested remediation: ${remediation}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          {
            role: "system",
            content:
              "You are a security remediation assistant for a skill-file scanner. Given a single flagged line from a file and why it was flagged, rewrite ONLY that line to fix the issue, preserving its original indentation and staying syntactically valid for the surrounding file. Respond with ONLY the corrected line of text — no explanation, no markdown code fences, no surrounding quotes, no additional lines.",
          },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `Groq returned ${res.status}: ${text}` }, { status: 502 });
    }

    const data = await res.json();
    let suggestion: string = data?.choices?.[0]?.message?.content ?? "";
    suggestion = suggestion.trim();
    // Models occasionally wrap the line in a fence or quotes despite instructions not to.
    suggestion = suggestion.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
    if (
      (suggestion.startsWith('"') && suggestion.endsWith('"') && suggestion.length > 1) ||
      (suggestion.startsWith("'") && suggestion.endsWith("'") && suggestion.length > 1)
    ) {
      suggestion = suggestion.slice(1, -1);
    }
    // If it still replies with multiple lines, take the first non-empty one rather than
    // silently applying a multi-line blob into a single-line edit slot.
    const firstLine = suggestion.split("\n").find((l) => l.trim().length > 0) ?? suggestion;

    if (!firstLine) {
      return NextResponse.json({ error: "Groq returned an empty suggestion." }, { status: 502 });
    }

    return NextResponse.json({ suggestion: firstLine });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
