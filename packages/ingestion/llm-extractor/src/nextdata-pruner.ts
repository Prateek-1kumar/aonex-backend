// Shrinks a page's __NEXT_DATA__ blob to just the product-relevant subtree.
//
// pruneNextData walks the object keeping keys matching KEEP_PATTERN (and their
// descendants), then truncates string values to fit MAX_BYTES. Used by
// @aonex/ingestion-llm-extractor to build the __NEXT_DATA__ structured hint.

const KEEP_PATTERN = /product|item|sku|variant|image|price|stock|offer/i;
const MAX_BYTES = 4096;

export function pruneNextData(v: unknown): unknown {
  if (!v || typeof v !== "object") return null;
  const out = walk(v, false);
  const s = JSON.stringify(out);
  if (s.length <= MAX_BYTES) return out;
  // Truncate string values within the pruned tree to fit
  const truncated = truncateStrings(out, Math.floor((MAX_BYTES - 100) / Math.max(1, countStringNodes(out))));
  return truncated;
}

function walk(v: unknown, ancestorMatched: boolean): unknown {
  if (Array.isArray(v)) {
    return v.map((x) => walk(x, ancestorMatched)).filter((x) => x !== undefined);
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const matches = ancestorMatched || KEEP_PATTERN.test(k);
      const pruned = walk(val, matches);
      if (matches || (pruned && typeof pruned === "object" && Object.keys(pruned).length > 0)) {
        out[k] = pruned;
      }
    }
    return out;
  }
  return ancestorMatched ? v : undefined;
}

function countStringNodes(v: unknown): number {
  if (typeof v === "string") return 1;
  if (Array.isArray(v)) return v.reduce<number>((acc, x) => acc + countStringNodes(x), 0);
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>).reduce<number>((acc, x) => acc + countStringNodes(x), 0);
  }
  return 0;
}

function truncateStrings(v: unknown, maxLen: number): unknown {
  if (typeof v === "string") return v.length > maxLen ? v.slice(0, Math.max(10, maxLen)) : v;
  if (Array.isArray(v)) return v.map((x) => truncateStrings(x, maxLen));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = truncateStrings(val, maxLen);
    return o;
  }
  return v;
}
