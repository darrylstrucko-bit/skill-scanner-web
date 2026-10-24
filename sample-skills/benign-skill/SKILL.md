---
name: markdown-table-formatter
description: Reformats a loosely-aligned Markdown table into a properly padded,
  pipe-aligned table so it renders cleanly everywhere.
---

# Markdown Table Formatter

When the user provides a Markdown table that isn't column-aligned, reformat it so that:

1. Every `|` in a row lines up vertically with the same `|` in every other row.
2. Column widths are padded to the widest cell in that column (minimum 3 dashes in the
   separator row).
3. Leading/trailing whitespace inside cells is trimmed.
4. The header separator row (`---`) is normalized to `:---`, `:---:`, or `---:` based on
   any alignment colons already present; default to left-aligned (`---`) otherwise.

Return only the reformatted table in a fenced code block, with no additional commentary
unless the user's original table was malformed (e.g. mismatched column counts across
rows) — in that case, point out the specific row/column mismatch before returning a
best-effort reformatted version.
