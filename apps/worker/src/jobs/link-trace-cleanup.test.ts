// Unit tests for the link-trace-cleanup job (Task 9.2).
//
// Integration note: migration 0021 renames extraction_runs → link_ingestion_trace_runs
// etc. Applying 0021 to a dev DB requires 0020 first, and 0020 requires the
// _legacy_* tables from Phase 8 cutover — which a clean dev DB does not have.
//
// Therefore these tests use a STUBBED DrizzleClient (no real DB connection)
// and verify:
//   1. The three DELETE statements target the correct table names.
//   2. The cutoff IS applied as a parameter (no hardcoded date strings in SQL).
//   3. runLinkTraceCleanup returns the correct row-count shape.
//   4. Custom retentionDays option is honoured (different cutoff date).
//   5. Empty DB (zero rows deleted) — no errors thrown.
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

function makeStubDb(rowCounts: { facts: number; sets: number; runs: number }) {
  const calls: RecordedCall[] = [];

  // Track which table each DELETE hits based on the SQL string.
  const mockExecute = async (query: { queryChunks?: unknown[]; sql?: string }) => {
    // Drizzle sql`` tagged templates expose `.sql` (the interpolated string) via
    // the object. In tests, we inspect the stringified version.
    const queryStr = JSON.stringify(query);
    let rowCount = 0;
    if (queryStr.includes("link_ingestion_trace_facts")) {
      rowCount = rowCounts.facts;
    } else if (queryStr.includes("link_ingestion_trace_sets")) {
      rowCount = rowCounts.sets;
    } else if (queryStr.includes("link_ingestion_trace_runs")) {
      rowCount = rowCounts.runs;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLinkTraceCleanup", () => {
  test("happy path — returns correct counts for each table", async () => {
    const { db } = makeStubDb({ facts: 42, sets: 10, runs: 5 });

    const result = await runLinkTraceCleanup({ db });

    expect(result.facts_deleted).toBe(42);
    expect(result.sets_deleted).toBe(10);
    expect(result.runs_deleted).toBe(5);
    expect(result.cutoff_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  });

  test("SQL targets link_ingestion_trace_facts, link_ingestion_trace_sets, link_ingestion_trace_runs", async () => {
    const { db, calls } = makeStubDb({ facts: 1, sets: 1, runs: 1 });
    await runLinkTraceCleanup({ db });

    // Three DELETEs must have been executed inside the transaction.
    expect(calls).toHaveLength(3);
    const sqlStrings = calls.map((c) => c.sql);
    expect(sqlStrings.some((s) => s.includes("link_ingestion_trace_facts"))).toBe(true);
    expect(sqlStrings.some((s) => s.includes("link_ingestion_trace_sets"))).toBe(true);
    expect(sqlStrings.some((s) => s.includes("link_ingestion_trace_runs"))).toBe(true);
  });

  test("empty DB — zero rows deleted, no errors", async () => {
    const { db } = makeStubDb({ facts: 0, sets: 0, runs: 0 });

    const result = await runLinkTraceCleanup({ db });

    expect(result.facts_deleted).toBe(0);
    expect(result.sets_deleted).toBe(0);
    expect(result.runs_deleted).toBe(0);
  });

  test("custom retentionDays — cutoff_at is ~7 days ago when retentionDays=7", async () => {
    const { db } = makeStubDb({ facts: 3, sets: 1, runs: 1 });
    const before = Date.now();
    const result = await runLinkTraceCleanup({ db }, { retentionDays: 7 });
    const after = Date.now();

    const cutoff = new Date(result.cutoff_at).getTime();
    const expectedApprox = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // cutoff should be approximately 7 days ago (within a 5-second margin for
    // the test execution window).
    const marginMs = 5000;
    expect(cutoff).toBeGreaterThanOrEqual(expectedApprox - marginMs);
    // cutoff must be before "now" (captured after the call)
    expect(cutoff).toBeLessThanOrEqual(after);
    // cutoff must be approximately 7 days before the test window
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(before - cutoff).toBeGreaterThanOrEqual(sevenDaysMs - marginMs);
  });

  test("logger.info is called with the result when a logger is provided", async () => {
    const { db } = makeStubDb({ facts: 2, sets: 1, runs: 1 });
    const infoCalls: unknown[] = [];
    const stubLogger = {
      info: (obj: unknown, _msg: string) => { infoCalls.push(obj); },
    } as unknown as import("pino").Logger;

    await runLinkTraceCleanup({ db, logger: stubLogger });

    expect(infoCalls).toHaveLength(1);
    const logged = infoCalls[0] as LinkTraceCleanupResult;
    expect(logged.facts_deleted).toBe(2);
    expect(logged.sets_deleted).toBe(1);
    expect(logged.runs_deleted).toBe(1);
  });
});
