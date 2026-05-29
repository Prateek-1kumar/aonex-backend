// Phase 4 Task 1: blocking-key generation for entity resolution.
// A record emits several keys; pairs sharing any key get compared by the scorer.
// Avoids the N^2 cliff while keeping recall high.

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface BlockingSignals {
  brand?: string;
  archetype?: string;
  title?: string;
}

/** Generate blocking keys. A record may emit multiple keys; pairs sharing any
 *  key are compared by scorePair. Missing archetype → "arch:unknown". */
export function blockingKeys(s: BlockingSignals): string[] {
  const keys: string[] = [];
  const arch = s.archetype ? `arch:${s.archetype}` : "arch:unknown";
  if (s.brand) keys.push(`brand:${norm(s.brand)}|${arch}`);
  if (s.title) {
    const toks = norm(s.title).split(" ").filter(Boolean).slice(0, 2).join("_");
    if (toks) keys.push(`titletok:${toks}|${arch}`);
  }
  return keys;
}
