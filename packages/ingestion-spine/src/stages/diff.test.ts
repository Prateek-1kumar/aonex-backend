import { describe, it, expect } from "bun:test";
import { runDiff } from "./diff.js";

// ---------------------------------------------------------------------------
// Helpers — build minimal mock DB objects for the two paths.
// ---------------------------------------------------------------------------

function makeInsertDb(returningRows: Array<{ id: string }>) {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(returningRows)
        })
      })
    }),
    query: {
      proposedDiffs: {
        findFirst: async () => undefined
      }
    }
  };
}

function makeConflictDb(existingRow: { id: string }) {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([])  // conflict — nothing returned
        })
      })
    }),
    query: {
      proposedDiffs: {
        findFirst: async () => existingRow
      }
    }
  };
}

const baseInput = {
  tenantId: "tenant-1" as never,
  merchantId: "merchant-1" as never,
  factSetId: "fact-set-1",
  policyVersionId: "policy-v1",
  confidenceScore: 0.9,
  status: "open" as const,
  payload: { title: "Test Product" }
};

describe("runDiff — success path", () => {
  it("inserts proposed diff and returns created: true when no conflict", async () => {
    const db = makeInsertDb([{ id: "diff-1" }]);

    const result = await runDiff({ db: db as never, ...baseInput });

    expect(result.diffId).toBe("diff-1");
    expect(result.created).toBe(true);
  });

  it("uses 'policy' actorType when status is auto_approved", async () => {
    let captured: Record<string, unknown> | null = null;
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          captured = v;
          return {
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve([{ id: "diff-auto-1" }])
            })
          };
        }
      })
    };

    await runDiff({
      db: db as never,
      ...baseInput,
      status: "auto_approved"
    });

    expect(captured).not.toBeNull();
    expect(captured!.actorType).toBe("policy");
    expect(captured!.status).toBe("auto_approved");
  });
});

describe("runDiff — conflict/idempotency path", () => {
  it("returns existing diffId and created: false when insert conflicts", async () => {
    const db = makeConflictDb({ id: "diff-existing" });

    const result = await runDiff({ db: db as never, ...baseInput });

    expect(result.diffId).toBe("diff-existing");
    expect(result.created).toBe(false);
  });

  it("throws when insert conflicts AND no existing row can be found", async () => {
    const brokenDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([])
          })
        })
      }),
      query: {
        proposedDiffs: {
          findFirst: async () => undefined  // nothing in DB
        }
      }
    };

    await expect(
      runDiff({ db: brokenDb as never, ...baseInput })
    ).rejects.toThrow("Failed to persist proposed diff");
  });
});
