// Phase 2 Task 8: cost-capped, multi-source GTIN backfill.
// HTTP adapters are INJECTED (deps.icecat / deps.upcitemdb) — tests pass fakes,
// production wires real fetch wrappers in Phase 3. budgetLeft() short-circuits
// the call if the per-URL cost ceiling (T2) has been exhausted upstream.

export interface RegistryHit {
  gtin: string;
  title: string;
  brand: string;
}

/** Re-declared locally to avoid a cycle with @aonex/catalog-service.
 *  Matches the shape of catalog-service's Identifier for type=gtin/source=backfill:*. */
export interface BackfilledIdentifier {
  type: "gtin";
  value: string;
  source: string;        // e.g. "backfill:icecat" | "backfill:upcitemdb"
  corroborated: false;   // raw candidates always start weak; promoteBackfill flips this
}

export interface BackfillDeps {
  icecat:    (q: { title: string; brand: string; mpn?: string }) => Promise<RegistryHit | null>;
  upcitemdb: (q: { title: string; brand: string; mpn?: string }) => Promise<RegistryHit | null>;
  budgetLeft: () => boolean;
}

export interface BackfillResult {
  candidates: BackfilledIdentifier[];
  skipped?: "budget";
}

/** Look up GTIN candidates from independent registries in parallel.
 *  Returns ALL hits (multi-candidate; one per registry) — corroboration happens
 *  later via promoteBackfill (D3). No single-source pick-and-pray. */
export async function backfillGtin(
  q: { title: string; brand: string; mpn?: string },
  deps: BackfillDeps
): Promise<BackfillResult> {
  if (!deps.budgetLeft()) return { candidates: [], skipped: "budget" };

  const [icecatHit, upcHit] = await Promise.all([
    deps.icecat(q),
    deps.upcitemdb(q),
  ]);

  const candidates: BackfilledIdentifier[] = [];
  for (const [source, hit] of [
    ["backfill:icecat", icecatHit],
    ["backfill:upcitemdb", upcHit],
  ] as const) {
    if (hit?.gtin) {
      candidates.push({
        type: "gtin",
        value: hit.gtin,
        source,
        corroborated: false,
      });
    }
  }
  return { candidates };
}
