// Tests for the DLQ promote + replay helpers — plan task 5.5, spec §19.1.
//
// Real-Postgres tests: gated on DATABASE_URL (default
// postgres://aonex:aonex@localhost:5432/aonex_dev). Mirrors `poller.test.ts`'s
// fresh-per-test tenant + explicit cleanup pattern so concurrent test runs
// don't collide.
//
// `moveToDlq` is verified to be source-row-preserving (per migration 0016)
// and idempotent. `replayDlq` is verified across the four interesting paths:
// happy-path bulk replay, eventIds-scoped replay, dry-run, missing-source
// orphans, and limit clamping.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test
} from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  closeTestDb,
  connectTestDb,
  ensureTestTenant
} from "@aonex/db/testing";
import type { CatalogEvent, DrizzleClient } from "@aonex/db";
import { moveToDlq, replayDlq } from "./dlq.js";

let db: DrizzleClient;

beforeAll(async () => {
  db = await connectTestDb();
  await ensureTestTenant(db);
});

afterAll(async () => {
  await closeTestDb();
});

/** Fresh tenant id per test so concurrent runs don't bleed. */
function freshTenantId(): string {
  return randomUUID();
}

interface SeededEvent {
  eventId: number;
  occurredAt: Date;
  payload: { seed: number };
  productId: string;
}

/**
 * Insert one unpublished event row with `publish_attempts = initialAttempts`.
 * Returns the full row so tests can pass it to `moveToDlq` without a
 * round-trip.
 */
async function seedEvent(opts: {
  tenantId: string;
  seedIndex?: number;
  initialAttempts?: number;
  occurredAt?: Date;
}): Promise<SeededEvent> {
  const seedIndex = opts.seedIndex ?? 0;
  const occurredAt =
    opts.occurredAt ??
    new Date(Date.parse("2026-05-22T12:00:00Z") + seedIndex * 1000);
  const productId = randomUUID();
  const payload = { seed: seedIndex };
  const res = await db.execute(sql`
    INSERT INTO catalog_events
      (event_type, product_id, tenant_id, payload, occurred_at, publish_attempts)
    VALUES
      ('catalog.product.created',
       ${productId},
       ${opts.tenantId},
       ${JSON.stringify(payload)}::jsonb,
       ${occurredAt.toISOString()},
       ${opts.initialAttempts ?? 0})
    RETURNING event_id
  `);
  const row = res.rows[0] as { event_id: string | number };
  return {
    eventId: Number(row.event_id),
    occurredAt,
    payload,
    productId
  };
}

/**
 * Build a CatalogEvent-shaped object from a SeededEvent — what `moveToDlq`
 * expects. We don't need to round-trip through the DB for this; the row we
 * just inserted is sufficient.
 */
function toCatalogEvent(
  e: SeededEvent,
  opts: {
    tenantId: string;
    publishAttempts: number;
  }
): CatalogEvent {
  return {
    eventId: e.eventId,
    eventType: "catalog.product.created",
    productId: e.productId,
    tenantId: opts.tenantId,
    payload: e.payload,
    triggeredBy: null,
    occurredAt: e.occurredAt,
    publishedAt: null,
    publishAttempts: opts.publishAttempts
  } as CatalogEvent;
}

async function fetchEvent(eventId: number): Promise<{
  publishedAt: Date | null;
  publishAttempts: number;
} | null> {
  const res = await db.execute(sql`
    SELECT published_at, publish_attempts
    FROM catalog_events
    WHERE event_id = ${eventId}
    LIMIT 1
  `);
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as {
    published_at: Date | string | null;
    publish_attempts: number;
  };
  return {
    publishedAt:
      r.published_at === null
        ? null
        : r.published_at instanceof Date
          ? r.published_at
          : new Date(r.published_at),
    publishAttempts: r.publish_attempts
  };
}

async function fetchDlq(eventId: number): Promise<{
  failureReason: string;
  attempts: number;
  originalPayload: unknown;
  failedAt: Date;
} | null> {
  const res = await db.execute(sql`
    SELECT failure_reason, attempts, original_payload, failed_at
    FROM catalog_events_dlq
    WHERE event_id = ${eventId}
    LIMIT 1
  `);
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as {
    failure_reason: string;
    attempts: number;
    original_payload: unknown;
    failed_at: Date | string;
  };
  return {
    failureReason: r.failure_reason,
    attempts: r.attempts,
    originalPayload: r.original_payload,
    failedAt:
      r.failed_at instanceof Date ? r.failed_at : new Date(r.failed_at)
  };
}

async function countDlqForTenant(tenantId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM catalog_events_dlq d
    JOIN catalog_events ce ON ce.event_id = d.event_id
    WHERE ce.tenant_id = ${tenantId}
  `);
  return (res.rows[0] as { n: number }).n;
}

const tenantsToCleanup: string[] = [];
const orphanDlqEventIdsToCleanup: number[] = [];

async function cleanupTenant(tenantId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM catalog_events_dlq
    WHERE event_id IN (SELECT event_id FROM catalog_events WHERE tenant_id = ${tenantId})
  `);
  await db.execute(sql`DELETE FROM catalog_events WHERE tenant_id = ${tenantId}`);
}

afterEach(async () => {
  while (tenantsToCleanup.length > 0) {
    const t = tenantsToCleanup.pop()!;
    await cleanupTenant(t);
  }
  if (orphanDlqEventIdsToCleanup.length > 0) {
    // pg driver doesn't auto-cast JS arrays to Postgres arrays; build an
    // IN-list of bigint literals (mirrors the pattern in dlq.ts itself).
    const idList = sql.join(
      orphanDlqEventIdsToCleanup.map((id) => sql`${id}::bigint`),
      sql`, `
    );
    await db.execute(sql`
      DELETE FROM catalog_events_dlq
      WHERE event_id IN (${idList})
    `);
    orphanDlqEventIdsToCleanup.length = 0;
  }
});

describe("moveToDlq", () => {
  test("inserts DLQ row and LEAVES source row in catalog_events", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);
    const seeded = await seedEvent({ tenantId, initialAttempts: 5 });

    const event = toCatalogEvent(seeded, { tenantId, publishAttempts: 5 });
    const result = await moveToDlq({ db }, { event, reason: "test failure" });
    expect(result.inserted).toBe(true);

    // DLQ row: correct event_id, payload, reason, attempts, recent failed_at.
    const dlq = await fetchDlq(seeded.eventId);
    expect(dlq).not.toBeNull();
    expect(dlq!.failureReason).toBe("test failure");
    expect(dlq!.attempts).toBe(5);
    // original_payload is the JSONB column — Postgres returns parsed JSON.
    expect(dlq!.originalPayload).toEqual({ seed: 0 });
    // failed_at default is now(); should be within last 10s.
    expect(Date.now() - dlq!.failedAt.getTime()).toBeLessThan(10_000);

    // Source row in catalog_events is NOT deleted (migration 0016 contract).
    const source = await fetchEvent(seeded.eventId);
    expect(source).not.toBeNull();
    expect(source!.publishAttempts).toBe(5);
    expect(source!.publishedAt).toBeNull();
  });

  test("is idempotent on event_id (second call returns inserted: false)", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);
    const seeded = await seedEvent({ tenantId, initialAttempts: 5 });

    const event = toCatalogEvent(seeded, { tenantId, publishAttempts: 5 });

    const first = await moveToDlq({ db }, { event, reason: "first" });
    expect(first.inserted).toBe(true);

    const second = await moveToDlq({ db }, { event, reason: "second" });
    expect(second.inserted).toBe(false);

    // Only one DLQ row total — the first call's payload + reason wins.
    expect(await countDlqForTenant(tenantId)).toBe(1);
    const dlq = await fetchDlq(seeded.eventId);
    expect(dlq).not.toBeNull();
    expect(dlq!.failureReason).toBe("first");
  });
});

describe("replayDlq", () => {
  test("resets source rows and deletes DLQ sidecars (happy path)", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);

    // Seed 3 events + 3 DLQ rows.
    const seeded: SeededEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await seedEvent({
        tenantId,
        seedIndex: i,
        initialAttempts: 5
      });
      seeded.push(s);
      await moveToDlq(
        { db },
        {
          event: toCatalogEvent(s, { tenantId, publishAttempts: 5 }),
          reason: `failure_${i}`
        }
      );
    }
    expect(await countDlqForTenant(tenantId)).toBe(3);

    // Scope the replay to this tenant by passing eventIds — replayDlq is
    // global by default and could pick up rows from other concurrent tests.
    const ids = seeded.map((s) => s.eventId);
    const result = await replayDlq({ db }, { eventIds: ids });

    expect(result).toEqual({
      scanned: 3,
      replayed: 3,
      missingSource: 0,
      dryRun: false
    });

    // Source rows: publish_attempts back to 0, published_at NULL.
    for (const s of seeded) {
      const row = await fetchEvent(s.eventId);
      expect(row).not.toBeNull();
      expect(row!.publishAttempts).toBe(0);
      expect(row!.publishedAt).toBeNull();
    }

    // DLQ rows for this tenant are gone.
    expect(await countDlqForTenant(tenantId)).toBe(0);
  });

  test("eventIds filters to a subset; other DLQ rows remain", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);

    const seeded: SeededEvent[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await seedEvent({
        tenantId,
        seedIndex: i,
        initialAttempts: 5
      });
      seeded.push(s);
      await moveToDlq(
        { db },
        {
          event: toCatalogEvent(s, { tenantId, publishAttempts: 5 }),
          reason: `failure_${i}`
        }
      );
    }
    expect(await countDlqForTenant(tenantId)).toBe(5);

    // Replay only the first two ids.
    const targets = [seeded[0]!.eventId, seeded[1]!.eventId];
    const result = await replayDlq({ db }, { eventIds: targets });
    expect(result.scanned).toBe(2);
    expect(result.replayed).toBe(2);
    expect(result.missingSource).toBe(0);

    // Two DLQ rows removed; three remain.
    expect(await countDlqForTenant(tenantId)).toBe(3);

    // Targeted source rows were reset; the other three are untouched.
    for (let i = 0; i < seeded.length; i++) {
      const row = await fetchEvent(seeded[i]!.eventId);
      expect(row).not.toBeNull();
      if (i < 2) {
        expect(row!.publishAttempts).toBe(0);
      } else {
        expect(row!.publishAttempts).toBe(5);
      }
    }
  });

  test("dryRun: counts what would replay but mutates nothing", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);

    const seeded: SeededEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await seedEvent({
        tenantId,
        seedIndex: i,
        initialAttempts: 5
      });
      seeded.push(s);
      await moveToDlq(
        { db },
        {
          event: toCatalogEvent(s, { tenantId, publishAttempts: 5 }),
          reason: `failure_${i}`
        }
      );
    }
    expect(await countDlqForTenant(tenantId)).toBe(3);

    const ids = seeded.map((s) => s.eventId);
    const result = await replayDlq({ db }, { eventIds: ids, dryRun: true });
    expect(result).toEqual({
      scanned: 3,
      replayed: 3,
      missingSource: 0,
      dryRun: true
    });

    // Nothing actually changed.
    expect(await countDlqForTenant(tenantId)).toBe(3);
    for (const s of seeded) {
      const row = await fetchEvent(s.eventId);
      expect(row).not.toBeNull();
      expect(row!.publishAttempts).toBe(5);
      expect(row!.publishedAt).toBeNull();
    }
  });

  test("missingSource: DLQ row without matching catalog_events row is counted and left in place", async () => {
    // Direct INSERT into catalog_events_dlq with an event_id that has no
    // corresponding catalog_events row. Use a synthetic out-of-range id so
    // we cannot collide with real sequence values. We track it explicitly
    // for cleanup because the tenant-scoped cleanup helper joins via
    // catalog_events (which has no row to join through here).
    //
    // Pick an event_id well outside any real sequence values seen in tests
    // (BIGSERIAL starts at 1 and only ever increases for inserted rows; we
    // pick a constant 2^40 + random offset). The DB will accept any BIGINT.
    const orphanEventId = (1 << 30) + Math.floor(Math.random() * 1_000_000);
    orphanDlqEventIdsToCleanup.push(orphanEventId);

    await db.execute(sql`
      INSERT INTO catalog_events_dlq
        (event_id, original_payload, failure_reason, attempts, failed_at)
      VALUES
        (${orphanEventId},
         ${JSON.stringify({ orphan: true })}::jsonb,
         'orphan_test',
         5,
         now())
    `);

    const result = await replayDlq(
      { db },
      { eventIds: [orphanEventId] }
    );
    expect(result.scanned).toBe(1);
    expect(result.replayed).toBe(0);
    expect(result.missingSource).toBe(1);
    expect(result.dryRun).toBe(false);

    // DLQ row STAYS — we don't delete orphans automatically.
    const dlq = await fetchDlq(orphanEventId);
    expect(dlq).not.toBeNull();
    expect(dlq!.failureReason).toBe("orphan_test");
  });

  test("limit clamps the number of rows replayed in one call", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);

    const seeded: SeededEvent[] = [];
    for (let i = 0; i < 10; i++) {
      const s = await seedEvent({
        tenantId,
        seedIndex: i,
        initialAttempts: 5
      });
      seeded.push(s);
      await moveToDlq(
        { db },
        {
          event: toCatalogEvent(s, { tenantId, publishAttempts: 5 }),
          reason: `failure_${i}`
        }
      );
    }
    expect(await countDlqForTenant(tenantId)).toBe(10);

    // Limit to 3 — only 3 should replay. Scope to this tenant's ids so
    // sibling tests don't influence the count.
    const ids = seeded.map((s) => s.eventId);
    const result = await replayDlq({ db }, { eventIds: ids, limit: 3 });
    expect(result.scanned).toBe(3);
    expect(result.replayed).toBe(3);
    expect(result.missingSource).toBe(0);

    // 7 DLQ rows remain for this tenant.
    expect(await countDlqForTenant(tenantId)).toBe(7);
  });
});
