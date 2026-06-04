// Shrinks embedded JSON-LD blocks before they go into the extraction prompt.
//
// compressJsonLd keeps only product-relevant @types, prunes review/related-product
// keys, then trims to MAX_BYTES (drop trailing blocks, then truncate description).
// Used by @aonex/ingestion-llm-extractor's prompt-builder to fit structured hints.

const KEEP_TYPES = new Set(["Product", "Offer", "AggregateOffer", "Brand", "AggregateRating"]);
const DROP_KEYS = new Set(["review", "reviews", "relatedProduct", "isRelatedTo", "isSimilarTo"]);
const MAX_BYTES = 8192;

export function compressJsonLd(blocks: Record<string, unknown>[]): Record<string, unknown>[] {
  const kept: Record<string, unknown>[] = [];
  for (const b of blocks) {
    const t = b["@type"];
    const type = Array.isArray(t) ? t[0] : t;
    if (typeof type === "string" && KEEP_TYPES.has(type)) {
      kept.push(prune(b) as Record<string, unknown>);
    }
  }
  let serialized = JSON.stringify(kept);
  while (serialized.length > MAX_BYTES && kept.length > 1) {
    kept.pop();
    serialized = JSON.stringify(kept);
  }
  if (serialized.length > MAX_BYTES && kept.length > 0) {
    const o = kept[0] as Record<string, unknown>;
    if (o && typeof o["description"] === "string") {
      o["description"] = (o["description"] as string).slice(0, 500);
    }
    serialized = JSON.stringify(kept);
    if (serialized.length > MAX_BYTES) {
      // Final fallback: truncate description aggressively
      if (o && typeof o["description"] === "string") {
        o["description"] = "";
      }
    }
  }
  return kept;
}

function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) continue;
      o[k] = prune(val);
    }
    return o;
  }
  return v;
}
