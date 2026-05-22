// Tests for the outbox poller — plan task 5.3, spec §19.1.
//
// Real-Postgres tests: gated on DATABASE_URL (default
// postgres://aonex:aonex@localhost:5432/aonex_dev). We use the shared
// `connectTestDb` helper so we don't churn pools across test files.
//
// Each test uses a fresh per-test tenant id (UUID-suffixed) to isolate from
// concurrently-running tests in this repo. Cleanup runs in `afterEach`.
//
// The Publisher under test is `MockPublisher` — a minimal in-memory sink that
// lets each test programme per-event success/failure. The point of these
// tests is the poller's claim→publish→mark/DLQ behaviour, not the publisher's
// own contract (covered by publishers/redis-streams.test.ts).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  closeTestDb,
  connectTestDb,
  ensureTestTenant,
  TEST_TENANT_ID
} from "@aonex/db/testing";
import type { DrizzleClient, CatalogEvent } from "@aonex/db";
import { makePoller } from "./poller.js";
import type { Publisher } from "./types.js";

let db: DrizzleClient;

beforeAll(async () => {
  db = await connectTestDb();
  await ensureTestTenant(db);
});

afterAll(async () => {
  await closeTestDb();
});

/** In-memory Publisher used by every test below. Per-event opt-in failure
 *  via `fail.set(eventIdAsString, reason)`. */
class MockPublisher implements Publisher {
  fail: Map<string, string> = new Map();
  publishedEventIds: number[] = [];
  publishCount = 0;

  async publish(events: CatalogEvent[]): Promise<{
    published: number;
    failed: { event: CatalogEvent; reason: string }[];
  }> {
    this.publishCount++;
    const failed: { event: CatalogEvent; reason: string }[] = [];
    let published = 0;
    for (const e of events) {
      const key = String(e.eventId);
      const reason = this.fail.get(key);
      if (reason !== undefined) {
        failed.push({ event: e, reason });
      } else {
        published++;
        this.publishedEventIds.push(Number(e.eventId));
      }
    }
    return { published, failed };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns a tenant id unique to one test so concurrent runs don't collide. */
function freshTenantId(): string {
  // Replace the last segment of TEST_TENANT_ID with a fresh suffix.
  // The base tenant row in `tenants` is what FK-bearing tables need; since
  // catalog_events has no FK on tenant_id, an arbitrary UUID is fine and
  // lets us scope cleanup precisely.
  return randomUUID();
}

/** Insert N unpublished events scoped to `tenantId`, each offset by minutes so
 *  occurred_at ordering is deterministic. Returns the inserted event_ids. */
async function seedUnpublishedEvents(opts: {
  tenantId: string;
  count: number;
  occurredAtBase?: Date;
  initialAttempts?: number;
}): Promise<number[]> {
  const base = opts.occurredAtBase ?? new Date(Date.parse("2026-05-22T12:00:00Z"));
  const ids: number[] = [];
  for (let i = 0; i < opts.count; i++) {
    const occurredAt = new Date(base.getTime() + i * 1000);
    const res = await db.execute(sql`
      INSERT INTO catalog_events
        (event_type, product_id, tenant_id, payload, occurred_at, publish_attempts)
      VALUES
        ('catalog.product.created',
         ${randomUUID()},
         ${opts.tenantId},
         ${JSON.stringify({ seed: i })}::jsonb,
         ${occurredAt.toISOString()},
         ${opts.initialAttempts ?? 0})
      RETURNING event_id
    `);
    const row = res.rows[0] as { event_id: string | number } | undefined;
    if (row) ids.push(Number(row.event_id));
  }
  return ids;
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
} | null> {
  const res = await db.execute(sql`
    SELECT failure_reason, attempts
    FROM catalog_events_dlq
    WHERE event_id = ${eventId}
    LIMIT 1
  `);
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as { failure_reason: string; attempts: number };
  return { failureReason: r.failure_reason, attempts: r.attempts };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM catalog_events_dlq
    WHERE event_id IN (SELECT event_id FROM catalog_events WHERE tenant_id = ${tenantId})
  `);
  await db.execute(sql`DELETE FROM catalog_events WHERE tenant_id = ${tenantId}`);
}

const tenantsToCleanup: string[] = [];

afterEach(async () => {
  while (tenantsToCleanup.length > 0) {
    const t = tenantsToCleanup.pop()!;
    await cleanupTenant(t);
  }
});

describe("makePoller", () => {
  test("happy path: single worker claims a batch, publishes, marks published_at", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);
    const ids = await seedUnpublishedEvents({ tenantId, count: 5 });
    expect(ids.length).toBe(5);

    const publisher = new MockPublisher();
    const [worker] = makePoller({
      db,
      publisher,
      workerCount: 1,
      batchSize: 100,
      idleSleepMs: 50
    });
    expect(worker).toBeDefined();
    worker!.start();
    // One poll cycle is enough — we wait long enough for it to claim,
    // publish, mark published, and start sleeping on the next empty claim.
    await waitFor(async () => {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM catalog_events
        WHERE tenant_id = ${tenantId} AND published_at IS NOT NULL
      `);
      return (rows.rows[0] as { n: number }).n === 5;
    }, 3000);
    await worker!.stop();

    // All 5 rows now have published_at set and publish_attempts == 1.
    for (const id of ids) {
      const row = await fetchEvent(id);
      expect(row).not.toBeNull();
      expect(row!.publishedAt).not.toBeNull();
      expect(row!.publishAttempts).toBe(1);
    }

    // Publisher saw all 5 ids exactly once.
    expect(new Set(publisher.publishedEventIds).size).toBe(5);
    expect(publisher.publishedEventIds.length).toBe(5);
    for (const id of ids) {
      expect(publisher.publishedEventIds).toContain(id);
    }

    // Stats reflect reality.
    const stats = worker!.stats();
    expect(stats.claimed).toBe(5);
    expect(stats.processed).toBe(5);
    expect(stats.failed).toBe(0);
    expect(stats.dlqd).toBe(0);
  });

  test("SKIP LOCKED: two concurrent workers never process the same event", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);
    const totalEvents = 100;
    const ids = await seedUnpublishedEvents({ tenantId, count: totalEvents });
    expect(ids.length).toBe(totalEvents);

    const publisher = new MockPublisher();
    const workers = makePoller({
      db,
      publisher,
      workerCount: 2,
      batchSize: 20,
      idleSleepMs: 25
    });
    expect(workers.length).toBe(2);
    for (const w of workers) w.start();

    await waitFor(async () => {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM catalog_events
        WHERE tenant_id = ${tenantId} AND published_at IS NOT NULL
      `);
      return (rows.rows[0] as { n: number }).n === totalEvents;
    }, 5000);

    await Promise.all(workers.map((w) => w.stop()));

    // Each event was published exactly once, never duplicated. This is the
    // crux of the SKIP LOCKED contract — without it the two workers would
    // race and both claim the same row.
    expect(publisher.publishedEventIds.length).toBe(totalEvents);
    expect(new Set(publisher.publishedEventIds).size).toBe(totalEvents);
    for (const id of ids) {
      expect(publisher.publishedEventIds).toContain(id);
    }

    // Each event's publish_attempts == 1 (single claim).
    for (const id of ids) {
      const row = await fetchEvent(id);
      expect(row).not.toBeNull();
      expect(row!.publishAttempts).toBe(1);
      expect(row!.publishedAt).not.toBeNull();
    }
  });

  test("failed publish: increments publish_attempts, leaves published_at NULL, retries", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);
    const ids = await seedUnpublishedEvents({ tenantId, count: 3 });
    expect(ids.length).toBe(3);
    const [id0, id1, id2] = ids as [number, number, number];

    const publisher = new MockPublisher();
    publisher.fail.set(String(id1), "boom");

    const [worker] = makePoller({
      db,
      publisher,
      workerCount: 1,
      batchSize: 100,
      idleSleepMs: 25
    });

    worker!.start();
    await waitFor(async () => {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM catalog_events
        WHERE tenant_id = ${tenantId} AND published_at IS NOT NULL
      `);
      return (rows.rows[0] as { n: number }).n === 2;
    }, 3000);
    await worker!.stop();

    // id0, id2 published; id1 failed but only attempt 1 (still retryable).
    const r0 = await fetchEvent(id0);
    const r1 = await fetchEvent(id1);
    const r2 = await fetchEvent(id2);
    expect(r0!.publishedAt).not.toBeNull();
    expect(r0!.publishAttempts).toBe(1);
    expect(r1!.publishedAt).toBeNull();
    expect(r1!.publishAttempts).toBeGreaterThanOrEqual(1);
    expect(r2!.publishedAt).not.toBeNull();
    expect(r2!.publishAttempts).toBe(1);

    const attemptsAfterFirstRun = r1!.publishAttempts;

    // Not in DLQ yet — only one failed attempt.
    expect(await fetchDlq(id1)).toBeNull();

    // Now flip the mock so id1 succeeds on retry.
    publisher.fail.delete(String(id1));
    worker!.start();
    await waitFor(async () => {
      const row = await fetchEvent(id1);
      return row !== null && row.publishedAt !== null;
    }, 3000);
    await worker!.stop();

    const r1Final = await fetchEvent(id1);
    expect(r1Final!.publishedAt).not.toBeNull();
    // publish_attempts increments on each claim — so we should have observed
    // at least one more increment after the retry.
    expect(r1Final!.publishAttempts).toBeGreaterThan(attemptsAfterFirstRun);
  });

  test("after maxAttempts failed claims, event moves to catalog_events_dlq (source row retained)", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);
    // Seed one event with publish_attempts=4 already, simulating prior failures.
    // maxAttempts default = 5, so the next claim will land at attempts=5 →
    // DLQ trigger if publish fails.
    const ids = await seedUnpublishedEvents({
      tenantId,
      count: 1,
      initialAttempts: 4
    });
    const [eventId] = ids as [number];

    const publisher = new MockPublisher();
    publisher.fail.set(String(eventId), "persistent_failure");

    const [worker] = makePoller({
      db,
      publisher,
      workerCount: 1,
      batchSize: 10,
      idleSleepMs: 25,
      maxAttempts: 5
    });

    worker!.start();
    await waitFor(async () => {
      return (await fetchDlq(eventId)) !== null;
    }, 3000);
    await worker!.stop();

    // DLQ row exists with the right reason + attempts count.
    const dlq = await fetchDlq(eventId);
    expect(dlq).not.toBeNull();
    expect(dlq!.attempts).toBe(5);
    expect(dlq!.failureReason).toBe("persistent_failure");

    // Source row in catalog_events is NOT deleted (per migration 0016).
    const source = await fetchEvent(eventId);
    expect(source).not.toBeNull();
    expect(source!.publishAttempts).toBe(5);
    expect(source!.publishedAt).toBeNull();

    // Now restart the worker — the claim WHERE `publish_attempts < 5`
    // naturally excludes the exhausted row, so the publisher should NOT see
    // it again no matter how long we wait.
    const publishCountBefore = publisher.publishCount;
    worker!.start();
    await sleep(200);
    await worker!.stop();

    // The publisher may have polled and seen empty batches, but the event id
    // we DLQd must not appear in publishedEventIds and the DLQ row count
    // must remain 1.
    expect(publisher.publishedEventIds).not.toContain(eventId);
    const stats = worker!.stats();
    // Sanity: more polls happened (publishCount may stay the same since the
    // publisher is only called when there are claimed rows — but in any case
    // emptyPolls should have advanced).
    expect(stats.emptyPolls).toBeGreaterThan(0);
    // Empty batches don't drive publisher.publish — so publishCount unchanged
    // is the correct expectation when no other tenant's events leak in.
    expect(publisher.publishCount).toBe(publishCountBefore);
  });

  test("makePoller(workerCount=N) returns N independent handles, none auto-started", async () => {
    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);
    const publisher = new MockPublisher();
    const workers = makePoller({ db, publisher, workerCount: 3 });
    expect(workers.length).toBe(3);
    expect(workers.map((w) => w.id).sort()).toEqual([0, 1, 2]);

    // None started — publisher never called even after a wait.
    await sleep(100);
    expect(publisher.publishCount).toBe(0);

    // start/stop is idempotent.
    workers[0]!.start();
    workers[0]!.start();
    await workers[0]!.stop();
    await workers[0]!.stop();
  });

  test("seed contamination guard: rows pre-seeded under TEST_TENANT_ID do not affect freshTenantId tests", async () => {
    // Sanity: an event under the global TEST_TENANT_ID stays untouched after a
    // run scoped to a freshTenantId — there is no per-tenant scoping in the
    // poller (v1 global), so this verifies that our test cleanup is the
    // discriminator, not the poller itself. (If we ever add tenant scoping
    // this test will need to flip.)
    const globalTenantPre = await db.execute(sql`
      SELECT count(*)::int AS n FROM catalog_events
      WHERE tenant_id = ${TEST_TENANT_ID} AND published_at IS NOT NULL
    `);
    const pre = (globalTenantPre.rows[0] as { n: number }).n;

    const tenantId = freshTenantId();
    tenantsToCleanup.push(tenantId);
    await seedUnpublishedEvents({ tenantId, count: 1 });

    const publisher = new MockPublisher();
    const [worker] = makePoller({
      db,
      publisher,
      workerCount: 1,
      batchSize: 100,
      idleSleepMs: 25
    });
    worker!.start();
    await waitFor(async () => {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM catalog_events
        WHERE tenant_id = ${tenantId} AND published_at IS NOT NULL
      `);
      return (rows.rows[0] as { n: number }).n === 1;
    }, 3000);
    await worker!.stop();

    const globalTenantPost = await db.execute(sql`
      SELECT count(*)::int AS n FROM catalog_events
      WHERE tenant_id = ${TEST_TENANT_ID} AND published_at IS NOT NULL
    `);
    const post = (globalTenantPost.rows[0] as { n: number }).n;
    // The poller is global so it WILL also publish any unpublished rows under
    // TEST_TENANT_ID that other tests left behind — but the published count
    // should never DECREASE.
    expect(post).toBeGreaterThanOrEqual(pre);
  });
});

/**
 * Polls `predicate` every 25ms until it returns true or the timeout elapses.
 * Throws on timeout with a friendly message. Used to give the poller's async
 * loop time to drain a batch without sprinkling fixed-duration sleeps.
 */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}
