import { describe, it, expect } from "bun:test";
import { runApprove } from "./approve.js";

// ---------------------------------------------------------------------------
// approve.ts is a thin wrapper around catalog-service's applyApprovedDiff.
// We test it by injecting a stub db whose query interface satisfies the
// applyApprovedDiff early-return path (existing productVersion found) so we
// can confirm the wrapper forwards the diffId correctly and returns the
// expected shape without touching real Postgres.
// ---------------------------------------------------------------------------

function makeStubDb(productId: string, productVersionId: string) {
  return {
    query: {
      productVersions: {
        findFirst: async ({ where }: { where: unknown }) => {
          // Satisfy the existingVersion early-exit in applyApprovedDiff.
          // The where clause checks pv.proposedDiffId = diffId.
          // We return a matching row unconditionally for the test.
          void where;
          return { id: productVersionId, productId };
        }
      }
    }
  };
}

describe("runApprove", () => {
  it("returns productId and productVersionId from applyApprovedDiff", async () => {
    const db = makeStubDb("product-abc", "pv-xyz");

    const result = await runApprove({
      db: db as never,
      diffId: "diff-1"
    });

    expect(result.productId).toBe("product-abc");
    expect(result.productVersionId).toBe("pv-xyz");
  });

  it("forwards diffId correctly through applyApprovedDiff", async () => {
    let capturedDiffId: string | null = null;
    const db = {
      query: {
        productVersions: {
          findFirst: async (config: { where: (pv: Record<string, unknown>, ops: { eq: (col: unknown, val: unknown) => unknown }) => unknown }) => {
            // applyApprovedDiff calls findFirst with:
            //   where: (pv, { eq }) => eq(pv.proposedDiffId, input.diffId)
            // Intercept the eq() call to capture the diffId value.
            const fakeEq = (_col: unknown, val: unknown) => { capturedDiffId = val as string; return null; };
            config.where({ proposedDiffId: "col" }, { eq: fakeEq });
            return { id: "pv-sentinel", productId: "product-sentinel" };
          }
        }
      }
    };

    const result = await runApprove({
      db: db as never,
      diffId: "test-diff-xyz"
    });

    expect(capturedDiffId).not.toBeNull();
    expect(capturedDiffId!).toBe("test-diff-xyz");
    expect(result.productVersionId).toBe("pv-sentinel");
    expect(result.productId).toBe("product-sentinel");
  });
});
