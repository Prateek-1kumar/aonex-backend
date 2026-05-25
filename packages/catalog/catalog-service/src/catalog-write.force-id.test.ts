// Tests for the forceProductId short-circuit in writeAdapterOutput.
//
// Covers the anomaly-lab "promote / link to existing" path: a reviewer has
// confirmed the match, so the write service must attach observations to a
// specific existing product even when the AdapterOutput's identityHint would
// NOT resolve to it via normal identity resolution.

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

// Use a unique tenant UUID distinct from any other test file to avoid
// cross-test contamination.
const FORCE_ID_TEST_TENANT_ID =
  "ffffffff-f0f0-4000-b000-000000000099" as unknown as TenantId;
const MERCHANT = TEST_MERCHANT_ID as unknown as MerchantId;

const TEST_ACTOR = "test:catalog-write-force-id";

// ---- Helpers ---------------------------------------------------------------

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
  // catalog_product_revisions has an immutability trigger; disable around
  // the test-tenant scrub then re-enable.
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
  // Seed a dedicated tenant for this test file (distinct UUID from the shared
  // TEST_TENANT_ID used by sibling tests). onConflictDoNothing makes re-runs
  // idempotent.
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
    // Seed a product P with an identity that the incoming AdapterOutput will
    // NOT match (different GTIN, no overlapping identity signals). The
    // AdapterOutput intentionally has a completely different titleForFuzzy
    // and no gtin/mpn/brand — normal resolution would create a NEW product.
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

    // Count products before to confirm no new row is inserted.
    const beforeCount = Number(
      (
        await db
          .select({ count: sql<string>`count(*)::text` })
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.tenantId, FORCE_ID_TEST_TENANT_ID))
      )[0]!.count
    );

    // AdapterOutput with an identity hint that has NOTHING in common with
    // the seeded product: different title, no gtin/mpn/brand. Normal
    // resolution would return productId:null → create=true. With
    // forceProductId, it must instead attach to forcedProductId.
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
          // Deliberately unrelated title — would NOT fuzzy-match the seeded
          // product (which has a different gtin and no matching title).
          titleForFuzzy: "ZZZ Completely Unrelated Product XYZ 99999",
          targetIsVariant: false
        }
      }),
      actor: TEST_ACTOR,
      forceProductId: forcedProductId
    });

    // --- Core assertions ---

    // Must attach to the specified product, not create a new one.
    expect(result.productId).toBe(forcedProductId);
    expect(result.created).toBe(false);

    // Contract: forceProductId always yields created=false and matchPath="gtin"
    // (the "gtin" is a placeholder for operator-forced; see forceProductId JSDoc).
    // These assertions lock the contract so a future change (e.g. adding a
    // "forced" IdentityMatchPath member) surfaces here explicitly.
    expect(result.created).toBe(false);
    expect(result.matchPath).toBe("gtin");

    // No new catalog_products row should have been inserted.
    const afterCount = Number(
      (
        await db
          .select({ count: sql<string>`count(*)::text` })
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.tenantId, FORCE_ID_TEST_TENANT_ID))
      )[0]!.count
    );
    expect(afterCount).toBe(beforeCount);

    // The title observation must have landed on the forced product's values.
    const productRow = await db
      .select({ values: schema.catalogProducts.values })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, forcedProductId));
    const values = productRow[0]!.values as Record<string, any>;
    expect(Array.isArray(values?.title?.["shopify-au"]?.en_AU)).toBe(true);
    expect(values.title["shopify-au"].en_AU.length).toBe(1);
    expect(values.title["shopify-au"].en_AU[0].value).toBe("Forced Attach Title");

    // observationsWritten should reflect the single title observation.
    expect(result.observationsWritten).toBe(1);
    expect(result.pricingObservationsWritten).toBe(0);
    expect(result.inventoryObservationsWritten).toBe(0);

    // Outbox event must be product.updated (not created).
    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(eq(schema.catalogEvents.productId, forcedProductId));
    expect(events.some((e) => e.eventType === "catalog.product.updated")).toBe(true);
  });
});
