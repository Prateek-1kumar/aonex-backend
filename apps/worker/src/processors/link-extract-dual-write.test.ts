// Phase 7 dual-write soak tests (Task 7.3).
//
// Tests the four flag combinations for `useNewCatalogSchema` x `useDualWrite`
// in the link-extract processor. Rather than standing up a full BullMQ + DB
// environment (covered by the integration suite in new-catalog-link-path.test.ts),
// these tests verify the branching logic by inspecting which write functions
// were called per flag state.
//
// Two layers of coverage:
//   1. These four logic-proof tests via `exerciseBranching` — fast, pure, fully
//      isolated. Document the intended flag semantics.
//   2. One coupling test in link-extract-processor-coupling.test.ts that calls
//      the REAL `makeLinkExtractProcessor` factory with both flags ON and asserts
//      BOTH write functions are called. This closes the gap where an inversion
//      of the condition in the real processor would not be caught here.

import { describe, expect, test } from "bun:test";

// ── Shared spy helpers ───────────────────────────────────────────────────────

/**
 * Minimal representation of what the processor needs to decide which path(s)
 * to run. Mirrors `LinkExtractProcessorDeps`.
 */
interface FlagState {
  useNewCatalogSchema: boolean;
  useDualWrite: boolean;
}

/**
 * Extracted dual-write branching logic, identical in structure to what lives
 * in `link-extract.processor.ts`:
 *
 *   if (useNewCatalogSchema) {
 *     await runNewPath();
 *     if (!useDualWrite) return;   // skip legacy in normal new-schema mode
 *   }
 *   await runLegacyPath();         // runs in: legacy-only OR dual-write mode
 *
 * Returns which paths were actually called.
 */
async function exerciseBranching(flags: FlagState): Promise<{
  newPathCalled: boolean;
  legacyPathCalled: boolean;
}> {
  let newPathCalled = false;
  let legacyPathCalled = false;

  const runNewPath = async () => {
    newPathCalled = true;
  };
  const runLegacyPath = async () => {
    legacyPathCalled = true;
  };

  if (flags.useNewCatalogSchema) {
    await runNewPath();
    if (!flags.useDualWrite) {
      // Normal new-schema mode: skip legacy, return early.
      return { newPathCalled, legacyPathCalled };
    }
    // Dual-write: intentionally fall through to legacy path below.
  }
  await runLegacyPath();

  return { newPathCalled, legacyPathCalled };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("link-extract processor: dual-write flag branching (Task 7.3)", () => {
  test("useNewSchema=false, dualWrite=false → legacy only", async () => {
    const result = await exerciseBranching({
      useNewCatalogSchema: false,
      useDualWrite: false,
    });
    expect(result.newPathCalled).toBe(false);
    expect(result.legacyPathCalled).toBe(true);
  });

  test("useNewSchema=true, dualWrite=false → new path only (normal post-Phase-4 behavior)", async () => {
    const result = await exerciseBranching({
      useNewCatalogSchema: true,
      useDualWrite: false,
    });
    expect(result.newPathCalled).toBe(true);
    expect(result.legacyPathCalled).toBe(false);
  });

  test("useNewSchema=true, dualWrite=true → BOTH paths run (Phase 7 soak)", async () => {
    const result = await exerciseBranching({
      useNewCatalogSchema: true,
      useDualWrite: true,
    });
    expect(result.newPathCalled).toBe(true);
    expect(result.legacyPathCalled).toBe(true);
  });

  test("useNewSchema=false, dualWrite=true → legacy only (dual-write no-ops without new schema)", async () => {
    // CATALOG_DUAL_WRITE without CATALOG_USE_NEW_SCHEMA is a no-op because
    // the new-path branch is never entered. Only the legacy path runs.
    const result = await exerciseBranching({
      useNewCatalogSchema: false,
      useDualWrite: true,
    });
    expect(result.newPathCalled).toBe(false);
    expect(result.legacyPathCalled).toBe(true);
  });
});
