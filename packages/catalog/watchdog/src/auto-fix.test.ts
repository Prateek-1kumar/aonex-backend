// Tests for autoFixDrift (plan §3.10, spec §13.3 — "discrepancy → auto-fix").
//
// Coverage:
//   1. Sync auto-fix — drift in winning_values for a sync attribute is
//      repaired by projectSync, leaving the stored winners equal to the
//      expected winners.
//   2. Async enqueue — pricing drift triggers an enqueue onto the supplied
//      reconciler Queue. We assert the job was added.
//   3. No queue — pricing drift with `queue` omitted from deps returns with
//      empty asyncEnqueued and logs deferred (does NOT throw).

import { afterAll, beforeAll, afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_CHANNEL_ID,
  TEST_MERCHANT_ID,
  TEST_TENANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestChannel,
  ensureTestMerchant,
  ensureTestTenant
} from "@aonex/db/testing";
import { reconcilerJobId, reconcilerQueueName } from "@aonex/catalog-service";
import { detectDrift } from "./drift-detector.js";
import { autoFixDrift } from "./auto-fix.js";

const TEST_ACTOR = "test:watchdog-auto-fix";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

async function seedRules(db: DrizzleClient): Promise<void> {
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

async function cleanup(db: DrizzleClient): Promise<void> {
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
    .update(schema.catalogProducts)
    .set({ parentProductId: null, mergedIntoProductId: null })
    .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

async function insertProduct(
  db: DrizzleClient,
  opts: {
    primaryIdentifier: string;
    values?: Record<string, unknown>;
    winningValues?: Record<string, unknown>;
  }
): Promise<string> {
  const insertValues: typeof schema.catalogProducts.$inferInsert = {
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    primaryIdentifier: opts.primaryIdentifier,
    identity: { brand: "Acme" },
    status: "active",
    values: opts.values ?? {}
  };
  if (opts.winningValues !== undefined) {
    insertValues.winningValues = opts.winningValues;
  }
  const rows = await db
    .insert(schema.catalogProducts)
    .values(insertValues)
    .returning();
  return rows[0]!.productId;
}

describe("autoFixDrift", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await cleanup(db);
    await seedRules(db);
  });

  afterEach(async () => {
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
      .update(schema.catalogProducts)
      .set({ parentProductId: null, mergedIntoProductId: null })
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  test("1. sync auto-fix: drift in winning_values is repaired by projectSync", async () => {
    const productId = await insertProduct(db, {
      primaryIdentifier: "AF-SYNC-1",
      values: {
        title: {
          _unscoped: {
            _unscoped: [
              {
                source: "shopify:connector",
                source_record_id: "shp#1",
                value: "Correct Title",
                confidence: 1,
                observed_at: "2026-05-21T10:00:00Z"
              }
            ]
          }
        }
      },
      // Stored winning_values are stale.
      winningValues: { title: { _unscoped: { _unscoped: "Stale Title" } } }
    });

    const drift = await detectDrift({ db }, productId);
    expect(drift.hasDrift).toBe(true);

    const result = await autoFixDrift({ db }, productId, drift);

    expect(result.syncProjected).toContain("title");

    // winning_values now matches the expected winner.
    const rows = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv = rows[0]!.winningValues as Record<string, any>;
    expect(wv.title._unscoped._unscoped).toBe("Correct Title");
  });

  test("2. pricing drift triggers enqueue onto provided Queue", async () => {
    const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    const queueName = reconcilerQueueName(TEST_TENANT_ID);
    const queue = new Queue(queueName, { connection });
    try {
      await queue.obliterate({ force: true });

      const productId = await insertProduct(db, {
        primaryIdentifier: "AF-PRC-1",
        values: {}
      });

      await db.insert(schema.catalogPricingObservations).values([
        {
          productId,
          tenantId: TEST_TENANT_ID,
          channelId: TEST_CHANNEL_ID,
          locale: "en_AU",
          source: "shopify:connector",
          currency: "AUD",
          tiers: [{ kind: "list", amount: 99.95 }],
          observedAt: new Date("2026-05-21T10:00:00Z")
        }
      ]);
      // No catalog_pricing_current row → expected has a winner, stored is
      // empty → drift.

      const drift = await detectDrift({ db }, productId);
      expect(drift.driftPricingCurrentRows.length).toBeGreaterThan(0);

      const result = await autoFixDrift(
        { db, queue, debounceMs: 0 },
        productId,
        drift
      );

      expect(result.asyncEnqueued.length).toBeGreaterThan(0);
      const pricingEnqueue = result.asyncEnqueued.find(
        (e) => e.attributeCode === "pricing"
      );
      expect(pricingEnqueue).toBeDefined();

      // Job exists in the queue under the conventional jobId.
      const expectedJobId = reconcilerJobId(productId, "pricing");
      const job = await queue.getJob(expectedJobId);
      expect(job).toBeDefined();
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    }
  });

  test("3. pricing drift WITHOUT a queue: returns empty asyncEnqueued, does not throw", async () => {
    const productId = await insertProduct(db, {
      primaryIdentifier: "AF-PRC-NOQ",
      values: {}
    });

    await db.insert(schema.catalogPricingObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "shopify:connector",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 49.99 }],
        observedAt: new Date("2026-05-21T10:00:00Z")
      }
    ]);

    const drift = await detectDrift({ db }, productId);
    expect(drift.driftPricingCurrentRows.length).toBeGreaterThan(0);

    const result = await autoFixDrift({ db }, productId, drift);
    expect(result.asyncEnqueued).toEqual([]);
  });
});
