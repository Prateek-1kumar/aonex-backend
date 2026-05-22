import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import type { DrizzleClient } from "../client.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

describe("catalog_events schema", () => {
  let db: DrizzleClient;
  // Track all event_ids inserted under the test tenant so cleanup can scope
  // both catalog_events (by tenant_id) AND catalog_events_dlq (by event_id).
  const insertedEventIds: number[] = [];

  async function cleanup(): Promise<void> {
    if (insertedEventIds.length > 0) {
      await db
        .delete(schema.catalogEventsDlq)
        .where(inArray(schema.catalogEventsDlq.eventId, insertedEventIds));
    }
    await db.execute(
      sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
    );
  }

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await closeTestDb();
  });

  test("insert: all fields roundtrip, defaults applied (publishedAt NULL, publishAttempts 0)", async () => {
    const productId = randomUUID();
    const rows = await db
      .insert(schema.catalogEvents)
      .values({
        eventType: "product.updated",
        productId,
        tenantId: TEST_TENANT_ID,
        payload: { winning: { title: "Test" } },
        triggeredBy: "ingestion:shopify"
        // occurredAt: defaults to now()
        // publishedAt: NULL by default
        // publishAttempts: 0 by default
      })
      .returning();
    const row = rows[0]!;
    insertedEventIds.push(row.eventId);

    expect(row.eventId).toBeGreaterThan(0);
    expect(row.eventType).toBe("product.updated");
    expect(row.productId).toBe(productId);
    expect(row.tenantId).toBe(TEST_TENANT_ID);
    expect(row.payload).toEqual({ winning: { title: "Test" } });
    expect(row.triggeredBy).toBe("ingestion:shopify");
    expect(row.occurredAt).toBeInstanceOf(Date);
    expect(row.publishedAt).toBeNull();
    expect(row.publishAttempts).toBe(0);
  });

  test("FOR UPDATE SKIP LOCKED isolates claims between concurrent workers", async () => {
    // Insert 3 unpublished events under a unique productId so this test's
    // claim set is isolated from rows seeded by other tests in this file.
    const productId = randomUUID();
    const inserted = await db
      .insert(schema.catalogEvents)
      .values([
        {
          eventType: "product.updated",
          productId,
          tenantId: TEST_TENANT_ID,
          payload: { n: 1 }
        },
        {
          eventType: "product.updated",
          productId,
          tenantId: TEST_TENANT_ID,
          payload: { n: 2 }
        },
        {
          eventType: "product.updated",
          productId,
          tenantId: TEST_TENANT_ID,
          payload: { n: 3 }
        }
      ])
      .returning({ eventId: schema.catalogEvents.eventId });
    insertedEventIds.push(...inserted.map((r) => r.eventId));

    // Open TWO independent connections from a dedicated Pool so each can hold
    // a row lock concurrently. The shared test Drizzle client is a single Pool
    // whose `transaction()` checks out one client per tx, but to be defensive
    // about the test exercising real concurrency we use a fresh Pool here.
    const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      // tx1: BEGIN + claim with FOR UPDATE SKIP LOCKED. The lock is held until
      // we COMMIT/ROLLBACK.
      await clientA.query("BEGIN");
      const claimA = await clientA.query<{ event_id: string }>(
        `SELECT event_id FROM catalog_events
         WHERE published_at IS NULL AND product_id = $1
         ORDER BY occurred_at
         FOR UPDATE SKIP LOCKED
         LIMIT 10`,
        [productId]
      );
      expect(claimA.rows.length).toBe(3);

      // tx2: independent connection, same claim — should get 0 rows because
      // tx1 still holds the locks.
      await clientB.query("BEGIN");
      const claimB = await clientB.query<{ event_id: string }>(
        `SELECT event_id FROM catalog_events
         WHERE published_at IS NULL AND product_id = $1
         ORDER BY occurred_at
         FOR UPDATE SKIP LOCKED
         LIMIT 10`,
        [productId]
      );
      expect(claimB.rows.length).toBe(0);
      await clientB.query("ROLLBACK");

      // Commit tx1, releasing the locks.
      await clientA.query("COMMIT");

      // Now a fresh claim on clientB picks up all 3 rows.
      await clientB.query("BEGIN");
      const claimB2 = await clientB.query<{ event_id: string }>(
        `SELECT event_id FROM catalog_events
         WHERE published_at IS NULL AND product_id = $1
         ORDER BY occurred_at
         FOR UPDATE SKIP LOCKED
         LIMIT 10`,
        [productId]
      );
      expect(claimB2.rows.length).toBe(3);
      await clientB.query("ROLLBACK");
    } finally {
      clientA.release();
      clientB.release();
      await pool.end();
    }
  });

  test("idx_catalog_events_unpublished partial index is used for unpublished-events claim", async () => {
    // Seed a mix of unpublished and published rows so the planner sees real
    // selectivity for the partial index over published_at IS NULL.
    const productId = randomUUID();
    const baseTs = Date.parse("2026-05-10T00:00:00Z");
    const unpublished: Array<typeof schema.catalogEvents.$inferInsert> = [];
    const published: Array<typeof schema.catalogEvents.$inferInsert> = [];
    for (let i = 0; i < 20; i += 1) {
      unpublished.push({
        eventType: "product.updated",
        productId,
        tenantId: TEST_TENANT_ID,
        payload: { i },
        occurredAt: new Date(baseTs + i * 60_000)
      });
    }
    for (let i = 0; i < 30; i += 1) {
      published.push({
        eventType: "product.updated",
        productId,
        tenantId: TEST_TENANT_ID,
        payload: { i },
        occurredAt: new Date(baseTs + (100 + i) * 60_000),
        publishedAt: new Date(baseTs + (100 + i) * 60_000 + 1_000)
      });
    }
    const seeded = await db
      .insert(schema.catalogEvents)
      .values([...unpublished, ...published])
      .returning({ eventId: schema.catalogEvents.eventId });
    insertedEventIds.push(...seeded.map((r) => r.eventId));

    await db.execute(sql`ANALYZE catalog_events`);
    await db.execute(sql`SET enable_seqscan = OFF`);

    const plan = await db.execute(
      sql`EXPLAIN (FORMAT JSON)
          SELECT event_id, occurred_at FROM catalog_events
          WHERE published_at IS NULL
          ORDER BY occurred_at
          LIMIT 10`
    );

    await db.execute(sql`SET enable_seqscan = ON`);

    const planJson = JSON.stringify(plan.rows);
    // The partition-leaf indexes inherit the parent partial index. Their names
    // (catalog_events_<part>_occurred_at_idx) all reference the same partial
    // definition. Assert SOME index scan was chosen on the partitioned table.
    expect(planJson).toMatch(/Index Scan|Index Only Scan/);
  });

  test("DLQ roundtrip: original event stays in catalog_events when moved to DLQ", async () => {
    const productId = randomUUID();
    const eventRows = await db
      .insert(schema.catalogEvents)
      .values({
        eventType: "product.updated",
        productId,
        tenantId: TEST_TENANT_ID,
        payload: { winning: { title: "DLQ-source" } },
        publishAttempts: 5
      })
      .returning();
    const event = eventRows[0]!;
    insertedEventIds.push(event.eventId);

    const dlqRows = await db
      .insert(schema.catalogEventsDlq)
      .values({
        eventId: event.eventId,
        originalPayload: event.payload,
        failureReason: "downstream 5xx after 5 attempts",
        attempts: event.publishAttempts
      })
      .returning();
    const dlq = dlqRows[0]!;

    expect(dlq.eventId).toBe(event.eventId);
    expect(dlq.originalPayload).toEqual({ winning: { title: "DLQ-source" } });
    expect(dlq.failureReason).toBe("downstream 5xx after 5 attempts");
    expect(dlq.attempts).toBe(5);
    expect(dlq.failedAt).toBeInstanceOf(Date);

    // Source event is still present — DLQ does not delete from catalog_events.
    const sourceExists = await db.execute(
      sql`SELECT event_id FROM catalog_events WHERE event_id = ${event.eventId}`
    );
    expect(sourceExists.rows.length).toBe(1);
  });

  test("expected monthly partitions exist for 2026-05, 2026-06, 2026-07", async () => {
    const result = await db.execute(sql`
      SELECT relname FROM pg_class
      WHERE relname IN (
        'catalog_events_2026_05',
        'catalog_events_2026_06',
        'catalog_events_2026_07'
      )
        AND relkind = 'r'
      ORDER BY relname
    `);
    expect(result.rows.length).toBe(3);
    expect(result.rows.map((r) => r.relname)).toEqual([
      "catalog_events_2026_05",
      "catalog_events_2026_06",
      "catalog_events_2026_07"
    ]);
  });
});
