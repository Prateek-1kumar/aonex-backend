// Tests for the forceProductId short-circuit in writeAdapterOutput: the
// "link to existing" path where a reviewer-confirmed match attaches
// observations to a specific product even when the identityHint would not
// resolve to it normally.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_MERCHANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestMerchant
} from "@aonex/db/testing";
import type { MerchantId, TenantId } from "@aonex/types";
import type {
  AdapterOutput,
  CanonicalObservation
} from "@aonex/catalog-source-adapters";
import { writeAdapterOutput } from "./catalog-write.js";

const FORCE_ID_TEST_TENANT_ID =
  "ffffffff-f0f0-4000-b000-000000000099" as unknown as TenantId;
const MERCHANT = TEST_MERCHANT_ID as unknown as MerchantId;

const TEST_ACTOR = "test:catalog-write-force-id";

function obs(overrides: Partial<CanonicalObservation> = {}): CanonicalObservation {
  return {
    attributeCode: "title",
    target: "parent",
    channelCode: "shopify-au",
    localeCode: "en_AU",
    source: "lab:reviewer",
    sourceRecordId: "lab-review-001",
    value: "Forced Attach Title",
    confidence: 1.0,
    observedAt: new Date("2026-05-25T10:00:00Z"),
    ...overrides
  };
}

function adapterOutput(parts: Partial<AdapterOutput> = {}): AdapterOutput {
  return {
    observations: [],
    pricingObservations: [],
    inventoryObservations: [],
    identityHint: { targetIsVariant: false },
    rawPayload: { src: "force-id-test" },
    ...parts
  };
}

async function cleanup(db: DrizzleClient): Promise<void> {
  await db
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, FORCE_ID_TEST_TENANT_ID));
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, FORCE_ID_TEST_TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${FORCE_ID_TEST_TENANT_ID}`
  );
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.catalogProductRevisions)
    .where(eq(schema.catalogProductRevisions.tenantId, FORCE_ID_TEST_TENANT_ID));
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.identityLog)
    .where(eq(schema.identityLog.tenantId, FORCE_ID_TEST_TENANT_ID));
  await db
    .delete(schema.reviewTasks)
    .where(eq(schema.reviewTasks.tenantId, FORCE_ID_TEST_TENANT_ID));
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, FORCE_ID_TEST_TENANT_ID));
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

async function seedTenant(db: DrizzleClient): Promise<void> {
  await db
    .insert(schema.tenants)
    .values({
      id: FORCE_ID_TEST_TENANT_ID as unknown as string,
      name: "Test Tenant (force-id tests)",
      status: "active"
    })
    .onConflictDoNothing();
}

async function seedRules(db: DrizzleClient): Promise<void> {
  await db.insert(schema.sourcePriority).values({
    tenantId: null,
    attributeCode: null,
    sourceGlob: "*",
    channelScope: null,
    priority: 100,
    rulesVersion: 1,
    actor: TEST_ACTOR
  });
}

describe("writeAdapterOutput — forceProductId (anomaly-lab link-to-existing)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await seedTenant(db);
    await ensureTestMerchant(db);
    await cleanup(db);
    await seedRules(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  test("forceProductId skips identity resolution and attaches to specified product", async () => {
    const seededProduct = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: FORCE_ID_TEST_TENANT_ID,
        merchantId: MERCHANT,
        primaryIdentifier: "seed:force-id-target-p",
        identity: { gtin: "99000000000099", identity_strength: 1.0 },
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const forcedProductId = seededProduct[0]!.productId;

    const beforeCount = Number(
      (
        await db
          .select({ count: sql<string>`count(*)::text` })
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.tenantId, FORCE_ID_TEST_TENANT_ID))
      )[0]!.count
    );

    const result = await writeAdapterOutput({
      db,
      tenantId: FORCE_ID_TEST_TENANT_ID,
      merchantId: MERCHANT,
      adapterOutput: adapterOutput({
        observations: [
          obs({
            value: "Forced Attach Title",
            sourceRecordId: "lab-review-forced-001"
          })
        ],
        identityHint: {
          titleForFuzzy: "ZZZ Completely Unrelated Product XYZ 99999",
          targetIsVariant: false
        }
      }),
      actor: TEST_ACTOR,
      forceProductId: forcedProductId
    });

    expect(result.productId).toBe(forcedProductId);
    expect(result.created).toBe(false);

    expect(result.created).toBe(false);
    expect(result.matchPath).toBe("gtin");

    const afterCount = Number(
      (
        await db
          .select({ count: sql<string>`count(*)::text` })
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.tenantId, FORCE_ID_TEST_TENANT_ID))
      )[0]!.count
    );
    expect(afterCount).toBe(beforeCount);

    const productRow = await db
      .select({ values: schema.catalogProducts.values })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, forcedProductId));
    const values = productRow[0]!.values as Record<string, any>;
    expect(Array.isArray(values?.title?.["shopify-au"]?.en_AU)).toBe(true);
    expect(values.title["shopify-au"].en_AU.length).toBe(1);
    expect(values.title["shopify-au"].en_AU[0].value).toBe("Forced Attach Title");

    expect(result.observationsWritten).toBe(1);
    expect(result.pricingObservationsWritten).toBe(0);
    expect(result.inventoryObservationsWritten).toBe(0);

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(eq(schema.catalogEvents.productId, forcedProductId));
    expect(events.some((e) => e.eventType === "catalog.product.updated")).toBe(true);
  });
});
