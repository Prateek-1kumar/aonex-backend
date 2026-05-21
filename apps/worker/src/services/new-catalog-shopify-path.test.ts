// Tests for the new-schema Shopify ingestion helper (Task 4.3).
//
// Verifies the NEW catalog path that runs under the `useNewCatalogSchema`
// flag from drain.processor.ts. Each test exercises the helper directly
// against the real dev DB so failures point at the catalog-write
// integration, not at Nango / gateway behaviour.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
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
  ensureTestTenant,
} from "@aonex/db/testing";
import type {
  ArtifactId,
  MerchantId,
  TenantId,
} from "@aonex/types";
import type { ShopifyProduct } from "@aonex/catalog-source-adapters";
import {
  runNewShopifyCatalogPath,
  resolveShopifyChannel,
} from "./new-catalog-shopify-path.js";

const TENANT = TEST_TENANT_ID as unknown as TenantId;
const MERCHANT = TEST_MERCHANT_ID as unknown as MerchantId;

const TEST_ACTOR = "test:new-catalog-shopify-path";

// The seeded test channel uses `accountRef='schema-tests'`, `region='au'`.
// We match those values so the happy-path test resolves to it.
const TEST_SHOP_DOMAIN = "schema-tests";
const TEST_REGION = "au";

// ---- Helpers ---------------------------------------------------------------

function makeShopifyProduct(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: "gid://shopify/Product/12345",
    title: "Test Widget Pro",
    handle: "test-widget-pro",
    status: "ACTIVE",
    vendor: "TestBrand",
    productType: "Widgets",
    tags: ["test", "widget"],
    updated_at: "2026-05-21T09:30:00Z",
    body_html: "<p>A widget for testing.</p>",
    options: [{ name: "size", values: ["S", "M"] }],
    images: [
      { url: "https://cdn.shopify.com/sample-1.jpg", altText: "Front view" },
    ],
    variants: [
      {
        id: "gid://shopify/ProductVariant/100",
        title: "Small",
        sku: "TW-PRO-S",
        barcode: "07000000000010",
        price: "29.99",
        compareAtPrice: "39.99",
        inventoryQuantity: 10,
        weight: 0.5,
        selectedOptions: [{ name: "size", value: "S" }],
      },
      {
        id: "gid://shopify/ProductVariant/101",
        title: "Medium",
        sku: "TW-PRO-M",
        barcode: "07000000000011",
        price: "29.99",
        compareAtPrice: null,
        inventoryQuantity: 5,
        weight: 0.6,
        selectedOptions: [{ name: "size", value: "M" }],
      },
    ],
    ...overrides,
  };
}

async function seedRules(db: DrizzleClient): Promise<void> {
  // Minimal default catch-all so projectSync has something to pick.
  await db.insert(schema.sourcePriority).values({
    tenantId: null,
    attributeCode: null,
    sourceGlob: "*",
    channelScope: null,
    priority: 100,
    rulesVersion: 1,
    actor: TEST_ACTOR,
  });
}

async function cleanup(db: DrizzleClient): Promise<void> {
  await db
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
  );
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.catalogProductRevisions)
    .where(eq(schema.catalogProductRevisions.tenantId, TEST_TENANT_ID));
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.identityLog)
    .where(eq(schema.identityLog.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.reviewTasks)
    .where(eq(schema.reviewTasks.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

describe("runNewShopifyCatalogPath (Task 4.3)", () => {
  let db: DrizzleClient;
  const observedAt = new Date("2026-05-21T10:00:00Z");

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await cleanup(db);
    await seedRules(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  test("1. happy path — creates product + variant pricing + inventory + revision + event", async () => {
    const product = makeShopifyProduct({
      id: "gid://shopify/Product/HAPPY-1",
      title: "Happy Path Widget",
      variants: [
        {
          id: "gid://shopify/ProductVariant/HV-1",
          title: "Default",
          sku: "HAPPY-1-V1",
          barcode: "07000000000100",
          price: "49.99",
          compareAtPrice: "59.99",
          inventoryQuantity: 7,
          weight: 1.0,
          selectedOptions: [{ name: "size", value: "S" }],
        },
        {
          id: "gid://shopify/ProductVariant/HV-2",
          title: "Default",
          sku: "HAPPY-1-V2",
          barcode: "07000000000101",
          price: "49.99",
          compareAtPrice: null,
          inventoryQuantity: 3,
          weight: 1.1,
          selectedOptions: [{ name: "size", value: "M" }],
        },
      ],
    });

    const result = await runNewShopifyCatalogPath({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      artifactId:
        "00000000-0000-0000-0000-0000000bcd01" as unknown as ArtifactId,
      shopDomain: TEST_SHOP_DOMAIN,
      region: TEST_REGION,
      shopifyProduct: product,
      observedAt,
    });

    expect(result.created).toBe(true);
    expect(result.channelResolved).toBe(true);
    expect(result.productId).toBeDefined();
    expect(result.matchPath).toBe("newly_created");
    // 2 variants → 2 pricing rows, 2 inventory rows
    expect(result.pricingObservationsWritten).toBe(2);
    expect(result.inventoryObservationsWritten).toBe(2);

    // catalog_products
    const products = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.productId));
    expect(products.length).toBe(1);

    // catalog_pricing_observations — 2 rows tied to the seeded channel
    const pricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, result.productId));
    expect(pricing.length).toBe(2);
    expect(pricing[0]!.channelId).toBe(TEST_CHANNEL_ID);
    expect(pricing[0]!.currency).toBe("AUD");

    // catalog_inventory_observations — 2 rows
    const inventory = await db
      .select()
      .from(schema.catalogInventoryObservations)
      .where(
        eq(schema.catalogInventoryObservations.productId, result.productId)
      );
    expect(inventory.length).toBe(2);

    // catalog_product_revisions
    const revisions = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(
        and(
          eq(schema.catalogProductRevisions.productId, result.productId),
          eq(schema.catalogProductRevisions.tenantId, TEST_TENANT_ID)
        )
      );
    expect(revisions.length).toBe(1);
    expect(revisions[0]!.revisionReason).toBe("create");
    expect(revisions[0]!.actor).toBe("shopify-connector");

    // catalog_events
    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(
        and(
          eq(schema.catalogEvents.productId, result.productId),
          eq(schema.catalogEvents.tenantId, TEST_TENANT_ID)
        )
      );
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("catalog.product.created");
  });

  test("2. unknown channel — product + revision + event still land, zero pricing/inventory", async () => {
    const product = makeShopifyProduct({
      id: "gid://shopify/Product/UNK-1",
      title: "Mystery Shop Widget",
      variants: [
        {
          id: "gid://shopify/ProductVariant/UV-1",
          title: "Default",
          sku: "UNK-1-V1",
          barcode: "07000000000200",
          price: "12.50",
          compareAtPrice: null,
          inventoryQuantity: 4,
          weight: 0.3,
          selectedOptions: [{ name: "size", value: "OneSize" }],
        },
      ],
    });

    const result = await runNewShopifyCatalogPath({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      artifactId:
        "00000000-0000-0000-0000-0000000bcd02" as unknown as ArtifactId,
      // No channel seeded for this shopDomain — resolver returns null.
      shopDomain: "unknown-shop.myshopify.com",
      region: TEST_REGION,
      shopifyProduct: product,
      observedAt,
    });

    expect(result.created).toBe(true);
    expect(result.channelResolved).toBe(false);
    expect(result.productId).toBeDefined();
    // Side-table observations stripped when channel is unresolved.
    expect(result.pricingObservationsWritten).toBe(0);
    expect(result.inventoryObservationsWritten).toBe(0);

    const pricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, result.productId));
    expect(pricing.length).toBe(0);

    const inventory = await db
      .select()
      .from(schema.catalogInventoryObservations)
      .where(
        eq(schema.catalogInventoryObservations.productId, result.productId)
      );
    expect(inventory.length).toBe(0);

    // Product + revision + event still landed.
    const products = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.productId));
    expect(products.length).toBe(1);

    const revisions = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, result.productId));
    expect(revisions.length).toBe(1);

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(eq(schema.catalogEvents.productId, result.productId));
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("catalog.product.created");
  });

  test("3. variant-level GTIN attaches to existing product — no new product row, updated event", async () => {
    const gtin = "07000000000300";
    const seed = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: `seed:${gtin}`,
        identity: { gtin, identity_strength: 1.0 },
        status: "active",
        values: {},
      })
      .returning({ productId: schema.catalogProducts.productId });
    const seededId = seed[0]!.productId;

    const before = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    const beforeCount = Number(before[0]!.count);

    const product = makeShopifyProduct({
      id: "gid://shopify/Product/ATTACH-1",
      title: "Existing Product, New Shopify Source",
      vendor: null,
      variants: [
        {
          id: "gid://shopify/ProductVariant/AV-1",
          title: "Default",
          sku: "ATTACH-1-V1",
          // First variant carries the GTIN that matches the seeded product.
          // identityHint.gtin is sourced from the FIRST variant with a barcode.
          barcode: gtin,
          price: "19.99",
          compareAtPrice: null,
          inventoryQuantity: 8,
          weight: 0.4,
          selectedOptions: [{ name: "size", value: "L" }],
        },
      ],
    });

    const result = await runNewShopifyCatalogPath({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      artifactId:
        "00000000-0000-0000-0000-0000000bcd03" as unknown as ArtifactId,
      shopDomain: TEST_SHOP_DOMAIN,
      region: TEST_REGION,
      shopifyProduct: product,
      observedAt,
    });

    expect(result.created).toBe(false);
    expect(result.productId).toBe(seededId);
    expect(result.channelResolved).toBe(true);
    // matchPath comes from the identity resolver; we only assert it's not
    // "newly_created" since the exact value is owned by the resolver.
    expect(result.matchPath).not.toBe("newly_created");

    // No new product row appeared.
    const after = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    expect(Number(after[0]!.count)).toBe(beforeCount);

    const revisions = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, seededId));
    expect(revisions.length).toBe(1);
    expect(revisions[0]!.revisionReason).toBe("new_source");

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(eq(schema.catalogEvents.productId, seededId));
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("catalog.product.updated");
  });

  test("4. resolveShopifyChannel returns null when shop_domain doesn't match", async () => {
    // The seeded test channel is (shopify, au, schema-tests). Anything else
    // must miss.
    const miss = await resolveShopifyChannel(
      db,
      TENANT,
      "nonexistent.myshopify.com",
      "au"
    );
    expect(miss).toBeNull();

    // Same shop_domain but wrong region also misses (region is part of the key).
    const wrongRegion = await resolveShopifyChannel(
      db,
      TENANT,
      TEST_SHOP_DOMAIN,
      "us"
    );
    expect(wrongRegion).toBeNull();

    // Exact match returns the channel.
    const hit = await resolveShopifyChannel(
      db,
      TENANT,
      TEST_SHOP_DOMAIN,
      TEST_REGION
    );
    expect(hit).not.toBeNull();
    expect(String(hit!.channelId)).toBe(TEST_CHANNEL_ID);
    expect(hit!.defaultCurrency).toBe("AUD");
    expect(hit!.defaultLocale).toBe("en_AU");
  });
});
