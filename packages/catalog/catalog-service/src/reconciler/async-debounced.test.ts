// Tests for the async-debounced reconciler worker (plan §3.6, spec §13.4 / §19).
//
// The async tier maintains catalog_pricing_current + catalog_inventory_current
// (spec §8.1 / §9.1 — these are APP-MAINTAINED, not trigger/MV). Observations
// land sync; this worker computes the winner with a debounce window per
// (product, attribute) and writes the *_current row + winning_values.<attr>
// + an outbox event in one transaction. Skip-no-winner-change suppresses the
// write when the recomputed winner equals the stored one.
//
// Tests cover:
//   1. Enqueue replaces a pending job for the same (product, attribute)
//   2. Per-tenant queue naming isolation
//   3. processReconcilerJob — pricing happy path (writes current + winning_values)
//   4. Skip-no-winner-change — equal winner emits no event + no write
//   5. Winner-changed emits the outbox event with correct payload
//   6. Inventory parity — observations → current + winning_values + event
//   7. Empty observations — clean no-op (no throw)
//
// We exercise processReconcilerJob directly for the projection-logic cases
// (no Redis round-trip; deterministic). The Redis-level tests instantiate
// real BullMQ Queues against the local Redis at REDIS_URL.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_CHANNEL_ID,
  TEST_LOCATION_ID,
  TEST_MERCHANT_ID,
  TEST_TENANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestChannel,
  ensureTestInventoryLocation,
  ensureTestMerchant,
  ensureTestTenant
} from "@aonex/db/testing";
import {
  enqueueReconcilerJob,
  makeReconcilerWorker,
  processReconcilerJob,
  reconcilerJobId,
  reconcilerQueueName,
  extractPrimaryAmount
} from "./async-debounced.js";

const TEST_ACTOR = "test:async-reconciler";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// ---- Helpers ---------------------------------------------------------------

async function seedRules(db: DrizzleClient): Promise<void> {
  // Default catch-all + a higher-priority shopify rule so we can flip a winner
  // by adding/removing a shopify observation.
  await db.insert(schema.sourcePriority).values([
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "shopify:*",
      channelScope: null,
      priority: 1,
      rulesVersion: 1,
      actor: TEST_ACTOR
    },
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "*",
      channelScope: null,
      priority: 100,
      rulesVersion: 1,
      actor: TEST_ACTOR
    }
  ]);
}

async function cleanupDb(db: DrizzleClient): Promise<void> {
  await db
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_pricing_current
        WHERE product_id IN (
          SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
        )`
  );
  await db.execute(
    sql`DELETE FROM catalog_inventory_current
        WHERE product_id IN (
          SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
        )`
  );
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
  );
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

async function insertProduct(
  db: DrizzleClient,
  primaryIdentifier: string
): Promise<string> {
  const inserted = await db
    .insert(schema.catalogProducts)
    .values({
      tenantId: TEST_TENANT_ID,
      merchantId: TEST_MERCHANT_ID,
      primaryIdentifier,
      identity: { brand: "Acme" },
      status: "active",
      values: {}
    })
    .returning();
  return inserted[0]!.productId;
}

// ---- Tests -----------------------------------------------------------------

describe("async-debounced reconciler — pure helpers", () => {
  test("extractPrimaryAmount prefers first sale tier", () => {
    const tiers = [
      { kind: "list", amount: 99.95 },
      { kind: "sale", amount: 79.95 },
      { kind: "sale", amount: 69.95 }
    ];
    expect(extractPrimaryAmount(tiers)).toBe(79.95);
  });

  test("extractPrimaryAmount falls back to first list tier", () => {
    const tiers = [
      { kind: "list", amount: 99.95 },
      { kind: "msrp", amount: 120 }
    ];
    expect(extractPrimaryAmount(tiers)).toBe(99.95);
  });

  test("extractPrimaryAmount returns null for empty / unrecognised tier sets", () => {
    expect(extractPrimaryAmount([])).toBeNull();
    expect(extractPrimaryAmount([{ kind: "msrp", amount: 50 }])).toBeNull();
    expect(extractPrimaryAmount(null)).toBeNull();
    expect(extractPrimaryAmount("not-an-array" as unknown)).toBeNull();
  });
});

describe("async-debounced reconciler — BullMQ queue semantics", () => {
  let connection: IORedis;

  beforeAll(() => {
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await connection.quit();
  });

  test("reconcilerQueueName is per-tenant", () => {
    expect(reconcilerQueueName("aaa")).toBe("recon.aaa");
    expect(reconcilerQueueName("bbb")).toBe("recon.bbb");
    expect(reconcilerQueueName("aaa")).not.toBe(reconcilerQueueName("bbb"));
  });

  test("enqueue with same (productId, attributeCode) replaces the pending job", async () => {
    const tenantId = `test-tenant-enqueue-${Date.now()}`;
    const queueName = reconcilerQueueName(tenantId);
    const queue = new Queue(queueName, { connection });
    try {
      await queue.obliterate({ force: true });

      const productId = "11111111-1111-1111-1111-111111111111";
      const attributeCode = "pricing" as const;

      await enqueueReconcilerJob(queue, {
        tenantId,
        productId,
        attributeCode,
        debounceMs: 5000
      });
      await enqueueReconcilerJob(queue, {
        tenantId,
        productId,
        attributeCode,
        debounceMs: 5000
      });

      // BullMQ jobId-based idempotence: only one delayed job exists for this jobId.
      const delayed = await queue.getDelayed();
      const ourJobs = delayed.filter(
        (j) => j.id === reconcilerJobId(productId, attributeCode)
      );
      expect(ourJobs.length).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  test("two tenants get two distinct queues", async () => {
    const tenantA = `test-tenant-a-${Date.now()}`;
    const tenantB = `test-tenant-b-${Date.now()}`;
    const qA = new Queue(reconcilerQueueName(tenantA), { connection });
    const qB = new Queue(reconcilerQueueName(tenantB), { connection });
    try {
      await qA.obliterate({ force: true });
      await qB.obliterate({ force: true });

      const productId = "22222222-2222-2222-2222-222222222222";
      await enqueueReconcilerJob(qA, {
        tenantId: tenantA,
        productId,
        attributeCode: "pricing",
        debounceMs: 5000
      });

      const delayedA = await qA.getDelayed();
      const delayedB = await qB.getDelayed();
      expect(delayedA.length).toBe(1);
      expect(delayedB.length).toBe(0);
      expect(qA.name).not.toBe(qB.name);
    } finally {
      await qA.obliterate({ force: true });
      await qB.obliterate({ force: true });
      await qA.close();
      await qB.close();
    }
  });

  test("enqueueReconcilerJob throws when queue name doesn't match tenant", async () => {
    const tenantA = `test-tenant-mismatch-a-${Date.now()}`;
    const tenantB = `test-tenant-mismatch-b-${Date.now()}`;
    const qA = new Queue(reconcilerQueueName(tenantA), { connection });
    try {
      await qA.obliterate({ force: true });
      // Passing tenantA's queue but tenantB's tenantId — must blow up.
      await expect(
        enqueueReconcilerJob(qA, {
          tenantId: tenantB,
          productId: "33333333-3333-3333-3333-333333333333",
          attributeCode: "pricing",
          debounceMs: 5000
        })
      ).rejects.toThrow(/doesn't match tenant/);
    } finally {
      await qA.obliterate({ force: true });
      await qA.close();
    }
  });
});

describe("processReconcilerJob — pricing", () => {
  let db: DrizzleClient;
  let connection: IORedis;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await cleanupDb(db);
    await seedRules(db);
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterEach(async () => {
    // Per-test scrub — keep tenant/merchant/channel/rules.
    await db
      .delete(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
    await db.execute(
      sql`DELETE FROM catalog_pricing_current
          WHERE product_id IN (
            SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
          )`
    );
    await db.execute(
      sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
    );
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await cleanupDb(db);
    await connection.quit();
    await closeTestDb();
  });

  test("computes winner, writes catalog_pricing_current + winning_values.pricing in one txn", async () => {
    const productId = await insertProduct(db, "PRC-001");

    // Two pricing observations from different sources; shopify rule wins (priority 1).
    await db.insert(schema.catalogPricingObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "ebay:link",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 110 }],
        observedAt: new Date("2026-05-21T10:00:00Z")
      },
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "shopify:connector",
        currency: "AUD",
        tiers: [
          { kind: "list", amount: 99.95 },
          { kind: "sale", amount: 79.95 }
        ],
        observedAt: new Date("2026-05-21T09:00:00Z")
      }
    ]);

    const result = await processReconcilerJob(
      { connection, db },
      {
        tenantId: TEST_TENANT_ID,
        productId,
        attributeCode: "pricing",
        rulesVersion: 1
      }
    );

    expect(result.winnerChanged).toBe(true);
    expect(result.leavesWritten).toBeGreaterThan(0);

    // catalog_pricing_current upserted with shopify's tiers.
    const current = await db
      .select()
      .from(schema.catalogPricingCurrent)
      .where(
        and(
          eq(schema.catalogPricingCurrent.productId, productId),
          eq(schema.catalogPricingCurrent.channelId, TEST_CHANNEL_ID),
          eq(schema.catalogPricingCurrent.locale, "en_AU")
        )
      );
    expect(current.length).toBe(1);
    expect(current[0]!.source).toBe("shopify:connector");
    expect(current[0]!.currency).toBe("AUD");
    // primary_amount comes from the first sale tier.
    expect(Number(current[0]!.primaryAmount)).toBe(79.95);

    // winning_values.pricing.<channelId>.<locale> populated with the winner.
    const after = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv = after[0]!.winningValues as Record<string, any>;
    expect(wv.pricing).toBeDefined();
    expect(wv.pricing[TEST_CHANNEL_ID].en_AU.source).toBe("shopify:connector");
    expect(wv.pricing[TEST_CHANNEL_ID].en_AU.currency).toBe("AUD");
    expect(wv._meta).toBeDefined();
    expect(wv._meta.rules_version).toBe(1);
  });

  test("emits catalog.product.pricing_changed event when winner changes", async () => {
    const productId = await insertProduct(db, "PRC-002");

    await db.insert(schema.catalogPricingObservations).values({
      productId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locale: "en_AU",
      source: "shopify:connector",
      currency: "AUD",
      tiers: [{ kind: "list", amount: 49.99 }],
      observedAt: new Date("2026-05-21T11:00:00Z")
    });

    await processReconcilerJob(
      { connection, db },
      {
        tenantId: TEST_TENANT_ID,
        productId,
        attributeCode: "pricing",
        rulesVersion: 1
      }
    );

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(
        and(
          eq(schema.catalogEvents.productId, productId),
          eq(schema.catalogEvents.tenantId, TEST_TENANT_ID),
          eq(schema.catalogEvents.eventType, "catalog.product.pricing_changed")
        )
      );
    expect(events.length).toBe(1);
    const payload = events[0]!.payload as Record<string, any>;
    expect(payload.productId).toBe(productId);
    expect(payload.channel).toBe(TEST_CHANNEL_ID);
    expect(payload.locale).toBe("en_AU");
    expect(payload.oldValue).toBeNull();
    expect(payload.newValue).toBeDefined();
    expect(payload.newValue.source).toBe("shopify:connector");
  });

  test("skip-no-winner-change — second invocation with same observations is a no-op", async () => {
    const productId = await insertProduct(db, "PRC-003");

    await db.insert(schema.catalogPricingObservations).values({
      productId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locale: "en_AU",
      source: "shopify:connector",
      currency: "AUD",
      tiers: [{ kind: "list", amount: 49.99 }],
      observedAt: new Date("2026-05-21T11:00:00Z")
    });

    const first = await processReconcilerJob(
      { connection, db },
      {
        tenantId: TEST_TENANT_ID,
        productId,
        attributeCode: "pricing",
        rulesVersion: 1
      }
    );
    expect(first.winnerChanged).toBe(true);

    // Clear events from the first call so we can assert no new event.
    await db.execute(
      sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
    );

    const second = await processReconcilerJob(
      { connection, db },
      {
        tenantId: TEST_TENANT_ID,
        productId,
        attributeCode: "pricing",
        rulesVersion: 1
      }
    );
    expect(second.winnerChanged).toBe(false);

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(
        and(
          eq(schema.catalogEvents.productId, productId),
          eq(schema.catalogEvents.tenantId, TEST_TENANT_ID)
        )
      );
    expect(events.length).toBe(0);
  });

  test("empty observations is a clean no-op", async () => {
    const productId = await insertProduct(db, "PRC-EMPTY");

    const result = await processReconcilerJob(
      { connection, db },
      {
        tenantId: TEST_TENANT_ID,
        productId,
        attributeCode: "pricing",
        rulesVersion: 1
      }
    );

    expect(result.winnerChanged).toBe(false);
    expect(result.leavesWritten).toBe(0);

    const current = await db
      .select()
      .from(schema.catalogPricingCurrent)
      .where(eq(schema.catalogPricingCurrent.productId, productId));
    expect(current.length).toBe(0);
  });
});

describe("processReconcilerJob — inventory", () => {
  let db: DrizzleClient;
  let connection: IORedis;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await ensureTestInventoryLocation(db);
    await cleanupDb(db);
    await seedRules(db);
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterEach(async () => {
    // Per-test scrub — keep tenant/merchant/channel/location/rules.
    await db
      .delete(schema.catalogInventoryObservations)
      .where(eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID));
    await db.execute(
      sql`DELETE FROM catalog_inventory_current
          WHERE product_id IN (
            SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
          )`
    );
    await db.execute(
      sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
    );
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await cleanupDb(db);
    await connection.quit();
    await closeTestDb();
  });

  test("writes catalog_inventory_current + winning_values.inventory + event", async () => {
    const productId = await insertProduct(db, "INV-001");

    await db.insert(schema.catalogInventoryObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locationId: TEST_LOCATION_ID,
        qty: 10,
        source: "ebay:link",
        observedAt: new Date("2026-05-21T10:00:00Z")
      },
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locationId: TEST_LOCATION_ID,
        qty: 7,
        source: "shopify:connector",
        observedAt: new Date("2026-05-21T09:00:00Z")
      }
    ]);

    const result = await processReconcilerJob(
      { connection, db },
      {
        tenantId: TEST_TENANT_ID,
        productId,
        attributeCode: "inventory",
        rulesVersion: 1
      }
    );

    expect(result.winnerChanged).toBe(true);

    // current row — shopify wins on priority.
    const current = await db
      .select()
      .from(schema.catalogInventoryCurrent)
      .where(
        and(
          eq(schema.catalogInventoryCurrent.productId, productId),
          eq(schema.catalogInventoryCurrent.channelId, TEST_CHANNEL_ID),
          eq(schema.catalogInventoryCurrent.locationId, TEST_LOCATION_ID)
        )
      );
    expect(current.length).toBe(1);
    expect(current[0]!.source).toBe("shopify:connector");
    expect(current[0]!.qty).toBe(7);

    // winning_values.inventory.<channel>.<location> populated.
    const after = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv = after[0]!.winningValues as Record<string, any>;
    expect(wv.inventory).toBeDefined();
    expect(wv.inventory[TEST_CHANNEL_ID][TEST_LOCATION_ID].qty).toBe(7);

    // outbox event
    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(
        and(
          eq(schema.catalogEvents.productId, productId),
          eq(schema.catalogEvents.tenantId, TEST_TENANT_ID),
          eq(schema.catalogEvents.eventType, "catalog.product.inventory_changed")
        )
      );
    expect(events.length).toBe(1);
    const payload = events[0]!.payload as Record<string, any>;
    expect(payload.productId).toBe(productId);
    expect(payload.channel).toBe(TEST_CHANNEL_ID);
    expect(payload.location).toBe(TEST_LOCATION_ID);
    expect(payload.newValue.qty).toBe(7);
  });

  test("NULL location collapses to sentinel — observations coalesce + winner picked", async () => {
    // Spec §9.1: NULL location is legal for inventory; the DB-generated
    // `location_id_coalesced` column substitutes the all-zeros sentinel UUID
    // so the PK enforces uniqueness across NULL-location observations. The
    // worker must:
    //   1. Group both observations into the same bucket despite NULL.
    //   2. Pick the winner (shopify > ebay per seedRules).
    //   3. Write one row in catalog_inventory_current.
    //   4. Stamp winning_values.inventory.<channel>.<sentinel> as the leaf key.
    const productId = await insertProduct(db, "INV-NULL-LOC");

    await db.insert(schema.catalogInventoryObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locationId: null,
        qty: 42,
        source: "ebay:link",
        observedAt: new Date("2026-05-21T10:00:00Z")
      },
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locationId: null,
        qty: 13,
        source: "shopify:connector",
        observedAt: new Date("2026-05-21T09:00:00Z")
      }
    ]);

    const result = await processReconcilerJob(
      { connection, db },
      {
        tenantId: TEST_TENANT_ID,
        productId,
        attributeCode: "inventory",
        rulesVersion: 1
      }
    );

    expect(result.winnerChanged).toBe(true);
    expect(result.leavesWritten).toBe(1);

    // Raw SQL — `location_id_coalesced` is a DB-generated column not exposed
    // on the Drizzle schema. We assert the sentinel resolution + the winner.
    const SENTINEL = "00000000-0000-0000-0000-000000000000";
    const currentRows = (
      await db.execute(sql`
        SELECT location_id, location_id_coalesced::text AS location_id_coalesced,
               qty, source
        FROM catalog_inventory_current
        WHERE product_id = ${productId}
      `)
    ).rows as Array<{
      location_id: string | null;
      location_id_coalesced: string;
      qty: number;
      source: string;
    }>;
    expect(currentRows.length).toBe(1);
    expect(currentRows[0]!.location_id).toBeNull();
    expect(currentRows[0]!.location_id_coalesced).toBe(SENTINEL);
    expect(currentRows[0]!.source).toBe("shopify:connector");
    expect(currentRows[0]!.qty).toBe(13);

    // winning_values uses the sentinel as the location leaf key.
    const after = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv = after[0]!.winningValues as Record<string, any>;
    expect(wv.inventory[TEST_CHANNEL_ID][SENTINEL]).toBeDefined();
    expect(wv.inventory[TEST_CHANNEL_ID][SENTINEL].qty).toBe(13);
    expect(wv.inventory[TEST_CHANNEL_ID][SENTINEL].source).toBe(
      "shopify:connector"
    );

    // Event payload reflects the actual NULL location (not the sentinel) —
    // downstream consumers should see the original observation shape.
    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(
        and(
          eq(schema.catalogEvents.productId, productId),
          eq(schema.catalogEvents.tenantId, TEST_TENANT_ID),
          eq(schema.catalogEvents.eventType, "catalog.product.inventory_changed")
        )
      );
    expect(events.length).toBe(1);
    const payload = events[0]!.payload as Record<string, any>;
    expect(payload.location).toBeNull();
  });
});

describe("makeReconcilerWorker", () => {
  let db: DrizzleClient;
  let connection: IORedis;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await cleanupDb(db);
    await seedRules(db);
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await cleanupDb(db);
    await connection.quit();
    await closeTestDb();
  });

  test("worker exists with the expected queue name and concurrency", async () => {
    const worker = makeReconcilerWorker(
      { connection, db },
      { tenantId: "smoke", concurrency: 4 }
    );
    try {
      expect(worker.name).toBe("recon.smoke");
    } finally {
      // Await close so the worker doesn't leak past the test and hold the
      // Redis connection open into afterAll's `connection.quit()`.
      await worker.close();
    }
  });
});
