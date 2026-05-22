// Tests for runDaily (plan §3.10, spec §13.3 — daily full-sweep tier).
//
// Iterates ALL products (status != 'merged_into') in chunks. Per chunk:
// detectDrift → autoFix → emit alerts. Returns aggregate stats + per-tenant
// breakdown.
//
// Coverage:
//   1. Full sweep — seed 5 clean products, run runDaily, expect sampled=5
//      driftFound=0.
//   2. Chunked iteration — seed 5 products, force chunkSize=2 via deps, and
//      assert all 5 still get processed (chunk boundary is invisible from
//      the stats POV but ensures the loop doesn't drop tail rows).
//   3. Tombstoned exclusion — merged_into products are NEVER swept.
//   4. Drift detected on one of N → autoFixed=1, others untouched.

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
import { runDaily } from "./daily.js";

const TEST_ACTOR = "test:watchdog-daily";

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
  return rows[0]!.productId;
}

describe("runDaily (plan §3.10, spec §13.3 — daily full-sweep tier)", () => {
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

  test("1. full sweep over 5 clean products → no drift found", async () => {
    for (let i = 0; i < 5; i++) {
      await insertProduct(db, {
        primaryIdentifier: `DAILY-CLEAN-${i}`,
        values: {},
        winningValues: {}
      });
    }
    const stats = await runDaily({ db });
    expect(stats.sampled).toBe(5);
    expect(stats.driftFound).toBe(0);
    expect(stats.autoFixed).toBe(0);
  });

  test("2. chunked iteration: chunkSize=2 still processes all 5 products", async () => {
    for (let i = 0; i < 5; i++) {
      await insertProduct(db, {
        primaryIdentifier: `DAILY-CHUNK-${i}`,
        values: {},
        winningValues: {}
      });
    }
    const stats = await runDaily({ db, chunkSize: 2 });
    expect(stats.sampled).toBe(5);
  });

  test("3. tombstoned products are excluded", async () => {
    await insertProduct(db, {
      primaryIdentifier: "DAILY-ACTIVE",
      values: {},
      winningValues: {}
    });
    await insertProduct(db, {
      primaryIdentifier: "DAILY-TOMB",
      status: "merged_into",
      values: {},
      winningValues: {}
    });

    const stats = await runDaily({ db });
    expect(stats.sampled).toBe(1);
  });

  test("4. drift on one of N → exactly one autoFixed", async () => {
    // Three clean + one with drift.
    for (let i = 0; i < 3; i++) {
      await insertProduct(db, {
        primaryIdentifier: `DAILY-MIXED-CLEAN-${i}`,
        values: {},
        winningValues: {}
      });
    }
    const driftId = await insertProduct(db, {
      primaryIdentifier: "DAILY-MIXED-DRIFT",
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
      winningValues: { title: { _unscoped: { _unscoped: "Stale Title" } } }
    });

    const stats = await runDaily({ db });
    expect(stats.sampled).toBe(4);
    expect(stats.driftFound).toBe(1);
    expect(stats.autoFixed).toBe(1);

    const after = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, driftId));
    const wv = after[0]!.winningValues as Record<string, any>;
    expect(wv.title._unscoped._unscoped).toBe("Correct Title");
  });
});
