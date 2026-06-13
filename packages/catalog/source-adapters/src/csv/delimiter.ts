// Delimiter sniffing — quote-aware, multi-candidate, multi-line.
//
// The old detectDelimiter() looked at the header line only and chose between
// "," and ";" by raw character count — so a header like
//   "Name, Description";Price;Qty   (semicolon-delimited, comma inside a quoted
// field) mis-detects as a comma file, and tab/pipe exports aren't handled at
// all. This version counts delimiters OUTSIDE quotes across a sample of lines
// and picks the candidate that splits every line into the same field count.

export type Delimiter = "," | ";" | "\t" | "|";
const CANDIDATES: Delimiter[] = [",", ";", "\t", "|"];
const SAMPLE_LINES = 20;

/** Count a delimiter's occurrences in one line, ignoring those inside "quotes"
 *  ("" is an escaped quote inside a quoted field). */
function countOutsideQuotes(line: string, delim: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { i++; continue; } // escaped ""
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === delim) {
      count++;
    }
  }
  return count;
}

/** Take up to SAMPLE_LINES non-empty lines for sniffing. */
function sampleLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= text.length && out.length < SAMPLE_LINES; i++) {
    if (i === text.length || text[i] === "\n") {
      const line = text.slice(start, i).replace(/\r$/, "");
      if (line.trim() !== "") out.push(line);
      start = i + 1;
    }
  }
  return out;
}

/**
 * Detect the delimiter. A good delimiter appears a consistent, non-zero number
 * of times on every sampled line; we score by how many lines agree on that
 * count and break ties by the (larger) field count. Falls back to ",".
 */
export function detectDelimiter(text: string): Delimiter {
  const lines = sampleLines(text);
  if (lines.length === 0) return ",";

  let best: Delimiter = ",";
  let bestScore = -1;
  let bestCount = -1;

  for (const delim of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, delim));
    if (counts.every((c) => c === 0)) continue; // delimiter absent

    // Modal (most common) non-zero count, and how many lines hit it.
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let modeCount = 0;
    let agree = 0;
    for (const [count, n] of freq) {
      if (count === 0) continue;
      if (n > agree || (n === agree && count > modeCount)) { agree = n; modeCount = count; }
    }
    // Prefer the delimiter most lines agree on; tie-break on the header's field count.
    if (agree > bestScore || (agree === bestScore && modeCount > bestCount)) {
      best = delim;
      bestScore = agree;
      bestCount = modeCount;
    }
  }
  return best;
}
