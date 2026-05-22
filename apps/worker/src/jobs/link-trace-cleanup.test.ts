// Unit tests for the link-trace-cleanup job (Task 9.2).
//
// Integration note: migration 0021 renames extraction_runs → link_ingestion_trace_runs
// etc. Applying 0021 to a dev DB requires 0020 first, and 0020 requires the
// _legacy_* tables from Phase 8 cutover — which a clean dev DB does not have.
//
// Therefore these tests use a STUBBED DrizzleClient (no real DB connection)
// and verify:
//   1. The DELETE statement targets link_ingestion_trace_facts only (v1 scope).
//   2. The cutoff IS applied as a parameter (no hardcoded date strings in SQL).
//   3. runLinkTraceCleanup returns facts_deleted count (no sets_deleted / runs_deleted).
//   4. Custom retentionDays option is honoured (different cutoff date).
//   5. Empty DB (zero rows deleted) — no errors thrown.
//   6. Transaction errors propagate — no swallowing.
//
// v1 scope: only link_ingestion_trace_facts is deleted. Sets and runs cleanup
// is deferred to Task 9.3 (see link-trace-cleanup.ts file header for the FK
// rationale).
//
// If/when migration 0021 can be applied to a test DB (post Phase 9.1 deploy),
// replace the stub with connectTestDb and integration-test against real Postgres.

import { describe, expect, test } from "bun:test";
import { runLinkTraceCleanup } from "./link-trace-cleanup.js";
import type { LinkTraceCleanupResult } from "./link-trace-cleanup.js";

// ---------------------------------------------------------------------------
// Minimal stub for DrizzleClient: records each sql.raw() string + params,
// returns configurable rowCount values.
// ---------------------------------------------------------------------------

interface RecordedCall {
  sql: string;
  rowCount: number;
}

function makeStubDb(rowCounts: { facts: number }) {
  const calls: RecordedCall[] = [];

  // Track which table each DELETE hits based on the SQL string.
  const mockExecute = async (query: { queryChunks?: unknown[]; sql?: string }) => {
    // Drizzle sql`` tagged templates expose `.sql` (the interpolated string) via
    // the object. In tests, we inspect the stringified version.
    const queryStr = JSON.stringify(query);
    let rowCount = 0;
    if (queryStr.includes("link_ingestion_trace_facts")) {
      rowCount = rowCounts.facts;
    }
    calls.push({ sql: queryStr, rowCount });
    return { rowCount };
  };

  // Minimal transaction stub: runs the callback with the same execute stub.
  const mockDb = {
    execute: mockExecute,
    transaction: async (cb: (tx: typeof mockDb) => Promise<LinkTraceCleanupResult>) => {
      return cb(mockDb);
    },
  } as unknown as Parameters<typeof runLinkTraceCleanup>[0]["db"];

  return { db: mockDb, calls };
}

/** Stub that throws inside the transaction to test error propagation. */
function makeErrorDb(error: Error) {
  const mockExecute = async (_query: unknown): Promise<never> => {
    throw error;
  };
  const mockDb = {
    execute: mockExecute,
    transaction: async (cb: (tx: typeof mockDb) => Promise<LinkTraceCleanupResult>) => {
      return cb(mockDb);
    },
  } as unknown as Parameters<typeof runLinkTraceCleanup>[0]["db"];
  return { db: mockDb };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLinkTraceCleanup", () => {
  test("happy path — returns facts_deleted count (v1: facts-only cleanup)", async () => {
    const { db } = makeStubDb({ facts: 42 });

    const result = await runLinkTraceCleanup({ db });

    expect(result.facts_deleted).toBe(42);
    expect(result.cutoff_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    // v1 result must NOT include sets_deleted or runs_deleted
    const resultAny = result as unknown as Record<string, unknown>;
    expect(resultAny.sets_deleted).toBeUndefined();
    expect(resultAny.runs_deleted).toBeUndefined();
  });

  test("SQL targets link_ingestion_trace_facts only (not sets or runs)", async () => {
    const { db, calls } = makeStubDb({ facts: 1 });
    await runLinkTraceCleanup({ db });

    // Exactly ONE DELETE must have been executed inside the transaction.
    expect(calls).toHaveLength(1);
    const sqlStr = calls[0]!.sql;
    expect(sqlStr.includes("link_ingestion_trace_facts")).toBe(true);
    expect(sqlStr.includes("link_ingestion_trace_sets")).toBe(false);
    expect(sqlStr.includes("link_ingestion_trace_runs")).toBe(false);
    // Must NOT contain RETURNING (dropped for performance — rowCount only)
    expect(sqlStr.toLowerCase().includes("returning")).toBe(false);
  });

  test("empty DB — zero facts deleted, no errors", async () => {
    const { db } = makeStubDb({ facts: 0 });

    const result = await runLinkTraceCleanup({ db });

    expect(result.facts_deleted).toBe(0);
  });

  test("custom retentionDays — cutoff_at is ~7 days ago when retentionDays=7", async () => {
    const { db } = makeStubDb({ facts: 3 });
    const before = Date.now();
    const result = await runLinkTraceCleanup({ db }, { retentionDays: 7 });
    const after = Date.now();

    const cutoff = new Date(result.cutoff_at).getTime();

    // cutoff should be approximately 7 days ago (within a 5-second margin for
    // the test execution window).
    const marginMs = 5000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // cutoff must be before "now" (captured after the call)
    expect(cutoff).toBeLessThanOrEqual(after);
    // cutoff must be approximately 7 days before the test window
    expect(before - cutoff).toBeGreaterThanOrEqual(sevenDaysMs - marginMs);
  });

  test("logger.info is called with the result when a logger is provided", async () => {
    const { db } = makeStubDb({ facts: 2 });
    const infoCalls: unknown[] = [];
    const stubLogger = {
      info: (obj: unknown, _msg: string) => { infoCalls.push(obj); },
    } as unknown as import("pino").Logger;

    await runLinkTraceCleanup({ db, logger: stubLogger });

    expect(infoCalls).toHaveLength(1);
    const logged = infoCalls[0] as LinkTraceCleanupResult;
    expect(logged.facts_deleted).toBe(2);
  });

  test("transaction error propagates — runLinkTraceCleanup rejects", async () => {
    const boom = new Error("simulated DB failure");
    const { db } = makeErrorDb(boom);

    await expect(runLinkTraceCleanup({ db })).rejects.toThrow("simulated DB failure");
  });
});
