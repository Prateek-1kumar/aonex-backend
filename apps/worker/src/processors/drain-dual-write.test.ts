// Drain processor dual-write flag branching tests (Phase 8 prereq B).
//
// Verifies the four flag combinations for `useNewCatalogSchema` x `useDualWrite`
// in the drain processor. Mirrors the approach from link-extract-dual-write.test.ts:
// tests run against an extracted branching function (no BullMQ or DB needed)
// that mirrors the production logic, so they are fast and fully isolated.
//
// Four cases tested:
//   1. flag OFF, dualWrite OFF → legacy only (pre-Phase-4 behavior).
//   2. flag ON,  dualWrite OFF → new path only (post-Phase-8 cutover behavior).
//   3. flag ON,  dualWrite ON  → both paths run (Phase 7 soak).
//   4. flag OFF, dualWrite ON  → legacy only (dualWrite no-ops without newSchema).

import { describe, expect, test } from "bun:test";

// ── Shared spy helpers ───────────────────────────────────────────────────────

interface FlagState {
  useNewCatalogSchema: boolean;
  useDualWrite: boolean;
}

/**
 * Extracted dual-write branching logic matching drain.processor.ts:
 *
 *   if (useNewCatalogSchema && isShopify && shopDomain) {
 *     await runNewPath();
 *     if (!useDualWrite) continue;  // skip legacy
 *   }
 *   await runLegacyPath();
 *
 * We model a single page iteration (no `for await` needed for the logic test).
 * Returns which paths were called.
 */
async function exerciseDrainBranching(flags: FlagState): Promise<{
  newPathCalled: boolean;
  legacyPathCalled: boolean;
}> {
  let newPathCalled = false;
  let legacyPathCalled = false;

  // Simulate: marketplace=shopify, shopDomain exists (the new-path condition
  // in drain.processor.ts requires both).
  const isShopify = true;
  const shopDomain = "test-shop.myshopify.com";

  const runNewPath = async () => { newPathCalled = true; };
  const runLegacyPath = async () => { legacyPathCalled = true; };

  if (flags.useNewCatalogSchema && isShopify && shopDomain) {
    await runNewPath();
    if (!flags.useDualWrite) {
      // Post-cutover: skip legacy entirely.
      return { newPathCalled, legacyPathCalled };
    }
    // Dual-write: fall through to legacy path below.
  }

  await runLegacyPath();

  return { newPathCalled, legacyPathCalled };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("drain processor: dual-write flag branching (Phase 8 prereq B)", () => {
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
});
