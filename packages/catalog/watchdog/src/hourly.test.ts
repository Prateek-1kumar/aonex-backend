// Tests for runHourly (plan §3.10, spec §13.3 — hourly tier).
//
// Same shape as continuous but: window = 1 hour, sample = 10%.
//
// Coverage:
//   1. Hourly window captures a product updated 30 minutes ago that
//      continuous would miss.
//   2. Drift triggers auto-fix.
//   3. Products outside the 1-hour window are excluded.

import { afterAll, beforeAll, afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_MERCHANT_ID,
  TEST_TENANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestMerchant,
  ensureTestTenant
} from "@aonex/db/testing";
import { runHourly } from "./hourly.js";

const TEST_ACTOR = "test:watchdog-hourly";

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
    status?: string;
    updatedAt?: Date;
  }
): Promise<string> {
  const insertValues: typeof schema.catalogProducts.$inferInsert = {
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    primaryIdentifier: opts.primaryIdentifier,
    identity: { brand: "Acme" },
    status: opts.status ?? "active",
    values: opts.values ?? {}
  };
  if (opts.winningValues !== undefined) {
    insertValues.winningValues = opts.winningValues;
  }
  const rows = await db
    .insert(schema.catalogProducts)
    .values(insertValues)
    .returning();
  const id = rows[0]!.productId;
  if (opts.updatedAt) {
    await db
      .update(schema.catalogProducts)
      .set({ updatedAt: opts.updatedAt })
      .where(eq(schema.catalogProducts.productId, id));
  }
  return id;
}

describe("runHourly (plan §3.10, spec §13.3 — hourly tier)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await cleanup(db);
    await seedRules(db);
  });

  afterEach(async () => {
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

  test("1. captures a product updated 30 minutes ago and repairs drift", async () => {
    const productId = await insertProduct(db, {
      primaryIdentifier: "HOUR-DRIFT-1",
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
      winningValues: { title: { _unscoped: { _unscoped: "Stale Title" } } },
      // 30 minutes ago — inside the 1-hour window, outside continuous's 5-min.
      updatedAt: new Date(Date.now() - 1000 * 60 * 30)
    });

    const stats = await runHourly({ db });
    expect(stats.sampled).toBeGreaterThanOrEqual(1);
    expect(stats.driftFound).toBe(1);
    expect(stats.autoFixed).toBe(1);

    const after = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv = after[0]!.winningValues as Record<string, any>;
    expect(wv.title._unscoped._unscoped).toBe("Correct Title");
  });

  test("2. products older than 1 hour are excluded", async () => {
    await insertProduct(db, {
      primaryIdentifier: "HOUR-OLD-1",
      updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2) // 2 hours ago
    });

    const stats = await runHourly({ db });
    expect(stats.sampled).toBe(0);
  });

  test("3. tombstoned products are excluded from the sample", async () => {
    await insertProduct(db, {
      primaryIdentifier: "HOUR-TOMB-1",
      status: "merged_into",
      updatedAt: new Date(Date.now() - 1000 * 60 * 30)
    });

    const stats = await runHourly({ db });
    expect(stats.sampled).toBe(0);
  });
});
