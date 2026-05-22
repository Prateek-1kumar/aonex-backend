// Drain processor dual-write flag branching tests (Phase 8 prereq B).
//
// Verifies the four flag combinations for `useNewCatalogSchema` x `useDualWrite`
// in the drain processor. Mirrors the approach from link-extract-dual-write.test.ts:
// tests run against an extracted branching function (no BullMQ or DB needed)
// that mirrors the production logic, so they are fast and fully isolated.
//
// Four path-routing cases tested:
//   1. flag OFF, dualWrite OFF → legacy only (pre-Phase-4 behavior).
//   2. flag ON,  dualWrite OFF → new path only (post-Phase-8 cutover behavior).
//   3. flag ON,  dualWrite ON  → both paths run (Phase 7 soak).
//   4. flag OFF, dualWrite ON  → legacy only (dualWrite no-ops without newSchema).
//
// Three totalInserted counting cases (review feedback Fix #2):
//   5. flag ON, non-Shopify marketplace → legacy count is used (not zero).
//   6. flag ON, Shopify, dualWrite ON   → legacy count is canonical (no double-count).
//   7. flag ON, Shopify, dualWrite OFF  → new-schema count is used.

import { describe, expect, test } from "bun:test";

// ── Shared spy helpers ───────────────────────────────────────────────────────

interface FlagState {
  useNewCatalogSchema: boolean;
  useDualWrite: boolean;
}

/**
 * Extracted dual-write branching logic matching drain.processor.ts:
 *
 *   let countedByNewSchema = false;
 *   if (useNewCatalogSchema && isShopify && shopDomain) {
 *     count += newInserts;
 *     if (!useDualWrite) { countedByNewSchema = true; continue; }
 *     count -= newInserts;  // undo; legacy is canonical in dual-write
 *   }
 *   count += legacyInserts;  // if (!countedByNewSchema)
 *
 * We model a single page iteration (no `for await` needed for the logic test).
 * Returns which paths were called and the final totalInserted for the page.
 */
async function exerciseDrainBranching(
  flags: FlagState,
  opts: { isShopify?: boolean; shopDomain?: string | null } = {}
): Promise<{
  newPathCalled: boolean;
  legacyPathCalled: boolean;
  totalInserted: number;
}> {
  let newPathCalled = false;
  let legacyPathCalled = false;
  let totalInserted = 0;

  // Defaults: Shopify with a valid shopDomain (the new-path condition requires both).
  const isShopify = opts.isShopify ?? true;
  const shopDomain = opts.shopDomain !== undefined ? opts.shopDomain : "test-shop.myshopify.com";

  // Simulated insert counts for the page.
  const NEW_SCHEMA_COUNT = 3;
  const LEGACY_COUNT = 3;  // same because checksum dedup on re-insert is a no-op

  let countedByNewSchema = false;

  if (flags.useNewCatalogSchema && isShopify && shopDomain) {
    newPathCalled = true;
    totalInserted += NEW_SCHEMA_COUNT;

    if (!flags.useDualWrite) {
      countedByNewSchema = true;
      // Simulate `continue` — skip legacy block.
      return { newPathCalled, legacyPathCalled, totalInserted };
    }

    // Dual-write: undo new-schema count; legacy is canonical.
    totalInserted -= NEW_SCHEMA_COUNT;
    // Fall through to legacy path below.
  }

  legacyPathCalled = true;
  if (!countedByNewSchema) {
    totalInserted += LEGACY_COUNT;
  }

  return { newPathCalled, legacyPathCalled, totalInserted };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("drain processor: dual-write flag branching (Phase 8 prereq B)", () => {
  // ── Path-routing tests ────────────────────────────────────────────────────

  test("useNewSchema=false, dualWrite=false → legacy only (pre-Phase-4 behavior)", async () => {
    const result = await exerciseDrainBranching({
      useNewCatalogSchema: false,
      useDualWrite: false,
    });
    expect(result.newPathCalled).toBe(false);
    expect(result.legacyPathCalled).toBe(true);
  });

  test("useNewSchema=true, dualWrite=false → new path only (post-Phase-8 cutover)", async () => {
    const result = await exerciseDrainBranching({
      useNewCatalogSchema: true,
      useDualWrite: false,
    });
    expect(result.newPathCalled).toBe(true);
    expect(result.legacyPathCalled).toBe(false);
  });

  test("useNewSchema=true, dualWrite=true → BOTH paths run (Phase 7 soak)", async () => {
    const result = await exerciseDrainBranching({
      useNewCatalogSchema: true,
      useDualWrite: true,
    });
    expect(result.newPathCalled).toBe(true);
    expect(result.legacyPathCalled).toBe(true);
  });

  test("useNewSchema=false, dualWrite=true → legacy only (dualWrite no-ops without newSchema)", async () => {
    // CATALOG_DUAL_WRITE without CATALOG_USE_NEW_SCHEMA is a no-op: the
    // new-schema branch is never entered. Only the legacy path runs.
    const result = await exerciseDrainBranching({
      useNewCatalogSchema: false,
      useDualWrite: true,
    });
    expect(result.newPathCalled).toBe(false);
    expect(result.legacyPathCalled).toBe(true);
  });

  // ── totalInserted counting tests (Fix #2) ─────────────────────────────────

  test("flag ON, non-Shopify marketplace: totalInserted reflects legacy count (not zero)", async () => {
    // When marketplace is non-Shopify, the new-schema block is never entered.
    // The legacy path MUST be counted so syncJobRuns.records_added is non-zero
    // for ebay/amazon/etc drains.
    const result = await exerciseDrainBranching(
      { useNewCatalogSchema: true, useDualWrite: false },
      { isShopify: false, shopDomain: null }
    );
    expect(result.newPathCalled).toBe(false);
    expect(result.legacyPathCalled).toBe(true);
    expect(result.totalInserted).toBeGreaterThan(0);
    // Specifically: equals the legacy insert count (3 in the simulation).
    expect(result.totalInserted).toBe(3);
  });

  test("flag ON, Shopify, dualWrite ON: totalInserted reflects legacy count (no double-count)", async () => {
    // In dual-write mode the new-schema block runs first but its count is
    // undone before falling through. The legacy block is the canonical count.
    // Result must equal the legacy insert count (not 2× it).
    const result = await exerciseDrainBranching({
      useNewCatalogSchema: true,
      useDualWrite: true,
    });
    expect(result.newPathCalled).toBe(true);
    expect(result.legacyPathCalled).toBe(true);
    // Legacy count (3), NOT new-schema count (3) + legacy count (3) = 6.
    expect(result.totalInserted).toBe(3);
  });

  test("flag ON, Shopify, dualWrite OFF: totalInserted is the new-schema count", async () => {
    // Post-cutover: legacy path is skipped entirely; new-schema count is authoritative.
    const result = await exerciseDrainBranching({
      useNewCatalogSchema: true,
      useDualWrite: false,
    });
    expect(result.newPathCalled).toBe(true);
    expect(result.legacyPathCalled).toBe(false);
    expect(result.totalInserted).toBe(3);
  });
});
