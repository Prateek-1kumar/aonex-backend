// packages/catalog/catalog-service/src/identity/idempotency.ts
// Phase 2 Task 11: content-hash idempotency (spec cross-cutting).
//
// Hashes a normalized payload (canonical fields + identity + pricing) so identical
// re-ingests of the same source artifact short-circuit re-extraction. Task 13's
// wiring is what constructs the normalized payload from an AdapterOutput; this
// module just turns a Record into a stable SHA-256 hex digest.
//
// "Stable" = key-order-independent. JSON.stringify with a sorted key list gives
// the same bytes regardless of insertion order. (Note: this does NOT recurse into
// nested object keys — for Phase 2 the AdapterOutput's top-level keys are the
// stable surface; nested objects come in a canonical order from the adapter.)

import { createHash } from "node:crypto";

/** Stable hash of an ingest payload (top-level keys sorted before stringify). */
export function contentHash(payload: Record<string, unknown>): string {
  const stable = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(stable).digest("hex");
}

/** Same source artifact re-ingested with identical content → reuse, don't recompute. */
export function isDuplicateIngest(hash: string, priorHashes: string[]): boolean {
  return priorHashes.includes(hash);
}
