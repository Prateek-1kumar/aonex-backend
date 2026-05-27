// Integration tests for promoteStagedProduct (Anomaly Lab Task 8).
//
// Uses the real DB. Unique tenant UUID to avoid collision with all other
// test files. Two cases:
//
//   1. Happy path:  staged product with pricing on a seeded channel, title +
//      category_path observations, missing brand + identifier (gtin/mpn).
//      promoteStagedProduct with fills { brand: "Acme", gtin: "p1000000000099" }
//      → productId set, catalog_products row exists, >= 2 reconciliation_overrides,
//        staged row status='promoted', resolvedBy set.
//
//   2. Still-incomplete path: same staged product, fills that leave gate
//      failing (e.g. only brand, no identifier).
//      → throws StillIncompleteError, staged row still 'pending',
//        NO reconciliation_overrides written, no new catalog_products row.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  connectTestDb,
  closeTestDb,
  ensureTestMerchant,
  TEST_MERCHANT_ID
} from "@aonex/db/testing";
import type { TenantId, MerchantId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import { stageProduct } from "./stage-product.js";
import { evaluateGate } from "../gate/evaluate-gate.js";
import {
  promoteStagedProduct,
  StillIncompleteError
} from "./promote-staged.js";

// ---- Unique IDs for this test suite ----------------------------------------
// Never collide with:
//   TEST_TENANT_ID         "00000000-…-0001"  (catalog-write.test.ts)
//   STAGE_PRODUCT_TENANT   "b0000000-…-0099"  (stage-product.test.ts)
//   TENANT_ID              "c0000000-…-0099"  (admit-or-stage.test.ts)
//   FORCE_ID_TEST_TENANT   "ffffffff-…-0099"  (catalog-write.force-id.test.ts)

const PROMOTE_TENANT_ID = "d0000000-0000-0000-0000-000000000099";
const PROMOTE_MERCHANT_ID = TEST_MERCHANT_ID;      // re-use shared merchant
const PROMOTE_CHANNEL_ID = "d0000000-0000-0000-0000-000000000098";
const PROMOTE_CHANNEL_CODE = "shopify-au";         // matches kind=shopify, region=au
// Amazon channel with an UPPER-CASE region — repro for the approve-500 where a
// pricing code "amazon-in" (lower-case URL tld) must resolve to an ("amazon","IN") row.
const PROMOTE_AMAZON_CHANNEL_ID = "d0000000-0000-0000-0000-000000000096";

const TENANT = PROMOTE_TENANT_ID as unknown as TenantId;
const MERCHANT = PROMOTE_MERCHANT_ID as unknown as MerchantId;

const TEST_ACTOR = "test:promote-staged";

// ---- Helpers ---------------------------------------------------------------

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

/**
 * Create an AdapterOutput that is missing brand + identifier (gtin/mpn),
 * but HAS a pricing observation on the seeded channel code, and has title +
 * category_path. This is the "typical staged product" scenario.
 */
function incompleteAdapterOutput(): AdapterOutput {
  return {
    observations: [
      {
        attributeCode: "title",
        target: "parent",
        channelCode: PROMOTE_CHANNEL_CODE,
        localeCode: "en-AU",
        source: "shopify:connector",
        sourceRecordId: "rec-promote-001",
        value: "Widget Tee",
        confidence: 0.95,
        observedAt: new Date("2026-05-25T10:00:00Z")
      },
      {
        attributeCode: "category_path",
        target: "parent",
        channelCode: PROMOTE_CHANNEL_CODE,
        localeCode: "en-AU",
        source: "shopify:connector",
        sourceRecordId: "rec-promote-001-cat",
        value: "Apparel > Tops",
        confidence: 0.95,
        observedAt: new Date("2026-05-25T10:00:00Z")
      }
    ],
    pricingObservations: [
      {
        productHint: "widget-tee",
        channelCode: PROMOTE_CHANNEL_CODE,
        locale: "en-AU",
        source: "shopify:connector",
        sourceRecordId: "rec-promote-v001",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 29.99 }],
        observedAt: new Date("2026-05-25T10:00:00Z")
      }
    ],
    inventoryObservations: [],
    identityHint: {
      // No brand, no gtin/mpn → gate fails on "brand" + "identifier"
      targetIsVariant: false
    },
    rawPayload: { src: "promote-staged-test" }
  };
}

async function stageIncompleteProduct(db: DrizzleClient): Promise<string> {
  const out = incompleteAdapterOutput();
  const verdict = evaluateGate({ adapterOutput: out, signals: [] });
  // Verify gate does indeed fail before staging (test integrity check)
  if (verdict.admit) {
    throw new Error(
      "test setup error: incompleteAdapterOutput should NOT pass the gate"
    );
  }

  const result = await stageProduct({
    db,
    tenantId: TENANT,
    merchantId: MERCHANT,
    adapterOutput: out,
    sourceKind: "shopify",
    channelCode: PROMOTE_CHANNEL_CODE,
    verdict,
    matchCandidates: []
  });
  return result.stagedProductId;
}

async function cleanup(db: DrizzleClient): Promise<void> {
  // reconciliation_overrides (FK cascade on catalog_products, but explicit
  // delete by tenantId join is cleaner for test isolation).
  await db.execute(
    sql`
      DELETE FROM reconciliation_overrides
      WHERE product_id IN (
        SELECT product_id FROM catalog_products
        WHERE tenant_id = ${PROMOTE_TENANT_ID}
      )
    `
  );

  // Staged products
  await db
    .delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.tenantId, PROMOTE_TENANT_ID));

  // Side tables
  await db
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, PROMOTE_TENANT_ID));
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, PROMOTE_TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${PROMOTE_TENANT_ID}`
  );

  // Revisions (immutable trigger)
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.catalogProductRevisions)
    .where(eq(schema.catalogProductRevisions.tenantId, PROMOTE_TENANT_ID));
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`
  );

  // Identity side-effects
  await db
    .delete(schema.identityLog)
    .where(eq(schema.identityLog.tenantId, PROMOTE_TENANT_ID));
  await db
    .delete(schema.reviewTasks)
    .where(eq(schema.reviewTasks.tenantId, PROMOTE_TENANT_ID));

  // Catalog products
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, PROMOTE_TENANT_ID));

  // Channels seeded for this suite (all channels for the unique tenant —
  // covers both the shopify-au and amazon-IN test channels).
  await db
    .delete(schema.channels)
    .where(eq(schema.channels.tenantId, PROMOTE_TENANT_ID));

  // Source priority rules
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));

  // Merchant seeded for this tenant (must delete before tenant due to FK)
  await db
    .delete(schema.merchants)
    .where(eq(schema.merchants.id, "d0000000-0000-0000-0000-000000000097"));

  // Tenant
  await db
    .delete(schema.tenants)
    .where(eq(schema.tenants.id, PROMOTE_TENANT_ID));
}

// ---- Suite setup -----------------------------------------------------------

describe("promoteStagedProduct (Task 8)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();

    // Seed tenant
    await db
      .insert(schema.tenants)
      .values({
        id: PROMOTE_TENANT_ID,
        name: "Test Tenant (promote-staged)",
        status: "active"
      })
      .onConflictDoNothing();

    // Ensure shared merchant exists (uses TEST_TENANT_ID, so no FK to our
    // test tenant — it's a shared test fixture)
    await ensureTestMerchant(db);

    // Seed a dedicated merchant for our tenant
    await db
      .insert(schema.merchants)
      .values({
        id: "d0000000-0000-0000-0000-000000000097",
        tenantId: PROMOTE_TENANT_ID,
        email: "test-promote-staged@promote-staged-tests.internal",
        passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only",
        displayName: "Test Merchant (promote-staged)",
        defaultCurrency: "AUD"
      })
      .onConflictDoNothing();

    // Seed channel for the tenant (channelKind=shopify, region=au →
    // resolveChannelCodeToId will match against "shopify-au")
    await db
      .insert(schema.channels)
      .values({
        channelId: PROMOTE_CHANNEL_ID,
        tenantId: PROMOTE_TENANT_ID,
        channelKind: "shopify",
        region: "au",
        accountRef: "promote-staged-tests",
        defaultCurrency: "AUD",
        defaultLocale: "en-AU",
        displayName: "Test Channel (promote-staged)"
      })
      .onConflictDoNothing();

    await cleanup(db);

    // Re-seed after cleanup wipes them
    await db
      .insert(schema.tenants)
      .values({
        id: PROMOTE_TENANT_ID,
        name: "Test Tenant (promote-staged)",
        status: "active"
      })
      .onConflictDoNothing();
    await db
      .insert(schema.merchants)
      .values({
        id: "d0000000-0000-0000-0000-000000000097",
        tenantId: PROMOTE_TENANT_ID,
        email: "test-promote-staged@promote-staged-tests.internal",
        passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only",
        displayName: "Test Merchant (promote-staged)",
        defaultCurrency: "AUD"
      })
      .onConflictDoNothing();
    await db
      .insert(schema.channels)
      .values({
        channelId: PROMOTE_CHANNEL_ID,
        tenantId: PROMOTE_TENANT_ID,
        channelKind: "shopify",
        region: "au",
        accountRef: "promote-staged-tests",
        defaultCurrency: "AUD",
        defaultLocale: "en-AU",
        displayName: "Test Channel (promote-staged)"
      })
      .onConflictDoNothing();
    // Amazon channel with UPPER-CASE region "IN" — see test #4.
    await db
      .insert(schema.channels)
      .values({
        channelId: PROMOTE_AMAZON_CHANNEL_ID,
        tenantId: PROMOTE_TENANT_ID,
        channelKind: "amazon",
        region: "IN",
        accountRef: "promote-staged-tests-amazon",
        defaultCurrency: "INR",
        defaultLocale: "en-IN",
        displayName: "Test Channel Amazon IN (promote-staged)"
      })
      .onConflictDoNothing();

    await seedRules(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  // ---- Happy path -----------------------------------------------------------
  test("1. promotes a staged product with pricing: writes catalog row, pins, flips status", async () => {
    const stagedProductId = await stageIncompleteProduct(db);

    // Count catalog_products before promote
    const beforeCount = Number(
      (
        await db
          .select({ count: sql<string>`count(*)::text` })
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.tenantId, PROMOTE_TENANT_ID))
      )[0]!.count
    );

    // Promote: provide brand + gtin to satisfy the gate
    const result = await promoteStagedProduct({
      db,
      tenantId: TENANT,
      stagedProductId,
      resolvedBy: "d0000000-0000-0000-0000-000000000097",
      fills: {
        brand: "Acme",
        gtin: "p1000000000099"
      }
    });

    // ---- Core: productId returned -------------------------------------------
    expect(result.productId).not.toBeNull();
    expect(typeof result.productId).toBe("string");

    // ---- catalog_products: one new row --------------------------------------
    const afterCount = Number(
      (
        await db
          .select({ count: sql<string>`count(*)::text` })
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.tenantId, PROMOTE_TENANT_ID))
      )[0]!.count
    );
    expect(afterCount).toBe(beforeCount + 1);

    const productRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.productId, result.productId!),
          eq(schema.catalogProducts.tenantId, PROMOTE_TENANT_ID)
        )
      );
    expect(productRows.length).toBe(1);

    // ---- reconciliation_overrides: >= 2 rows (one per fill) ----------------
    const overrideRows = await db.execute(
      sql`
        SELECT * FROM reconciliation_overrides
        WHERE product_id = ${result.productId}
        ORDER BY override_id
      `
    );
    expect(overrideRows.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of overrideRows.rows) {
      expect(row["actor"]).toBe("manual:lab");
      expect(typeof row["rationale"]).toBe("string");
      expect((row["rationale"] as string)).toContain(stagedProductId);
      expect(row["channel_code"]).toBe("_unscoped");
      expect(row["locale_code"]).toBe("_unscoped");
    }

    // Verify both fill keys are pinned
    const attributeCodes = overrideRows.rows.map((r) => r["attribute_code"] as string);
    expect(attributeCodes).toContain("brand");
    expect(attributeCodes).toContain("gtin");

    // ---- staged_products: status='promoted', resolvedBy set ----------------
    const stagedRows = await db
      .select()
      .from(schema.stagedProducts)
      .where(eq(schema.stagedProducts.stagedProductId, stagedProductId));
    expect(stagedRows.length).toBe(1);
    const staged = stagedRows[0]!;
    expect(staged.status).toBe("promoted");
    expect(staged.resolvedBy).toBe("d0000000-0000-0000-0000-000000000097");
    expect(staged.resolvedAt).not.toBeNull();
    const humanFills = staged.humanFills as Record<string, unknown>;
    expect(humanFills["brand"]).toBe("Acme");
    expect(humanFills["gtin"]).toBe("p1000000000099");
  });

  // ---- Still-incomplete path -----------------------------------------------
  test("2. still-incomplete fills: throws StillIncompleteError, writes NOTHING", async () => {
    const stagedProductId = await stageIncompleteProduct(db);

    // Count products before (must be same after)
    const beforeCount = Number(
      (
        await db
          .select({ count: sql<string>`count(*)::text` })
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.tenantId, PROMOTE_TENANT_ID))
      )[0]!.count
    );

    // Count existing overrides before the (failing) promote attempt
    const overridesBefore = (
      await db.execute(
        sql`
          SELECT count(*) as cnt
          FROM reconciliation_overrides ro
          INNER JOIN catalog_products cp ON cp.product_id = ro.product_id
          WHERE cp.tenant_id = ${PROMOTE_TENANT_ID}
        `
      )
    ).rows[0]!["cnt"] as string;
    const overridesBeforeCount = Number(overridesBefore);

    // Fills that satisfy brand but NOT identifier (gtin/mpn still missing)
    let thrown: unknown;
    try {
      await promoteStagedProduct({
        db,
        tenantId: TENANT,
        stagedProductId,
        resolvedBy: "d0000000-0000-0000-0000-000000000097",
        fills: { brand: "AcmeOnly" }  // still missing identifier
      });
    } catch (err) {
      thrown = err;
    }

    // ---- Must throw StillIncompleteError ------------------------------------
    expect(thrown).toBeInstanceOf(StillIncompleteError);
    const sie = thrown as StillIncompleteError;
    expect(sie.stillMissing).toContain("identifier");

    // ---- staged row must still be pending -----------------------------------
    const stagedRows = await db
      .select()
      .from(schema.stagedProducts)
      .where(eq(schema.stagedProducts.stagedProductId, stagedProductId));
    expect(stagedRows.length).toBe(1);
    expect(stagedRows[0]!.status).toBe("pending");

    // ---- NO new catalog_products row ----------------------------------------
    const afterCount = Number(
      (
        await db
          .select({ count: sql<string>`count(*)::text` })
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.tenantId, PROMOTE_TENANT_ID))
      )[0]!.count
    );
    expect(afterCount).toBe(beforeCount);

    // ---- NO new reconciliation_overrides written (count unchanged) ----------
    const overridesAfterRows = await db.execute(
      sql`
        SELECT count(*) as cnt
        FROM reconciliation_overrides ro
        INNER JOIN catalog_products cp ON cp.product_id = ro.product_id
        WHERE cp.tenant_id = ${PROMOTE_TENANT_ID}
      `
    );
    const overridesAfterCount = Number(
      (overridesAfterRows.rows[0]!["cnt"] as string)
    );
    expect(overridesAfterCount).toBe(overridesBeforeCount);
  });

  // ---- Identifier fill via the UI's "identifier" key (regression) ----------
  // The anomaly-lab form sends the hard ID under the key `identifier`
  // (field label: "Identifier (GTIN, MPN, or your SKU)"). It MUST map onto
  // identityHint so the gate's hasIdentifier() accepts it. Before the fix,
  // `identifier` fell through to a generic observation and the gate kept
  // reporting it missing — approve was impossible no matter what was typed.
  test("3. identifier fill (UI 'identifier' key) satisfies the gate and becomes primary_identifier", async () => {
    const stagedProductId = await stageIncompleteProduct(db);

    const result = await promoteStagedProduct({
      db,
      tenantId: TENANT,
      stagedProductId,
      resolvedBy: "d0000000-0000-0000-0000-000000000098",
      // brand satisfies the brand gate; identifier satisfies the identifier gate.
      fills: { brand: "OnePlus", identifier: "2345678763323" }
    });

    // Promotion succeeds → a product id is returned.
    expect(result.productId).toBeTruthy();

    // The filled identifier becomes the product's primary_identifier.
    const productRows = await db
      .select({ primaryIdentifier: schema.catalogProducts.primaryIdentifier })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.productId!));
    expect(productRows.length).toBe(1);
    expect(productRows[0]!.primaryIdentifier).toBe("2345678763323");

    // Staged row flips to promoted.
    const stagedRows = await db
      .select()
      .from(schema.stagedProducts)
      .where(eq(schema.stagedProducts.stagedProductId, stagedProductId));
    expect(stagedRows[0]!.status).toBe("promoted");
  });

  // ---- Channel resolution at promote must mirror ingest (regression: 500) --
  // Real-world repro: a product scraped from amazon.in carries pricing on
  // channelCode "amazon-in" (lower-case URL tld), but the registered channel is
  // (kind="amazon", region="IN"). Ingest resolved it by kind; promote must too.
  // The old promote resolver required an exact "amazon-IN" === "amazon-in"
  // match → UNRESOLVED → threw → approve 500. This asserts it now resolves.
  test("4. promote resolves a pricing channelCode against a differently-cased region (amazon-in → amazon/IN)", async () => {
    const out: AdapterOutput = {
      observations: [
        {
          attributeCode: "title", target: "parent", channelCode: "amazon-in",
          localeCode: "en-IN", source: "amazon-in:link", sourceRecordId: "amz-1",
          value: "OnePlus 13", confidence: 0.95, observedAt: new Date("2026-05-26T00:00:00Z")
        },
        {
          attributeCode: "category_path", target: "parent", channelCode: "amazon-in",
          localeCode: "en-IN", source: "amazon-in:link", sourceRecordId: "amz-1c",
          value: "electronics/mobiles", confidence: 0.9, observedAt: new Date("2026-05-26T00:00:00Z")
        }
      ],
      pricingObservations: [
        {
          productHint: "oneplus-13", channelCode: "amazon-in", locale: "en-IN",
          source: "amazon-in:link", sourceRecordId: "amz-1p", currency: "INR",
          tiers: [{ kind: "list", amount: 69999 }], observedAt: new Date("2026-05-26T00:00:00Z")
        }
      ],
      inventoryObservations: [],
      identityHint: { targetIsVariant: false },
      rawPayload: { src: "promote-channel-regression" }
    };

    const verdict = evaluateGate({ adapterOutput: out, signals: [] });
    expect(verdict.admit).toBe(false); // missing brand + identifier → staged

    const staged = await stageProduct({
      db, tenantId: TENANT, merchantId: MERCHANT, adapterOutput: out,
      sourceKind: "link", channelCode: "amazon-in", verdict, matchCandidates: []
    });

    // Approve with the two missing fields — must NOT 500 on channel resolution.
    const result = await promoteStagedProduct({
      db,
      tenantId: TENANT,
      stagedProductId: staged.stagedProductId,
      resolvedBy: "d0000000-0000-0000-0000-000000000097",
      fills: { brand: "OnePlus", identifier: "amz-oneplus-13" }
    });
    expect(result.productId).toBeTruthy();
  });
});
