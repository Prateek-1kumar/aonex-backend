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
    .delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.tenantId, TEST_TENANT_ID));
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

  test("1. new product with resolved channel — admitted (complete fixture satisfies CANONICAL_MINIMUM gate)", async () => {
    // After the shopify-connector adapter fix (emit "category_path" not "category"),
    // a complete Shopify product with title + vendor (brand) + productType
    // (category_path) + price + barcode (gtin) satisfies all CANONICAL_MINIMUM
    // fields and is admitted directly into catalog_products.
    //
    // Gate fields satisfied by this fixture:
    //   title       → "Happy Path Widget"
    //   brand       → identityHint.brand = "TestBrand" (from vendor in makeShopifyProduct base)
    //   pricing     → variant price "49.99" AUD (channel resolved → currency known)
    //   category_path → "Widgets" (from productType in makeShopifyProduct base)
    //   identifier  → identityHint.gtin = "07000000000100" (from first variant barcode)
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

    // Complete fixture satisfies CANONICAL_MINIMUM → admitted.
    expect(result.outcome).toBe("admitted");
    expect(result.channelResolved).toBe(true);
    expect(result.productId).not.toBeNull();
    expect(result.stagedProductId).toBeNull();

    // A catalog_products row must exist for the admitted product.
    const admittedProducts = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    const thisProduct = admittedProducts.filter(
      (p) => typeof p.identity === "object" && p.identity !== null &&
        (p.identity as Record<string, unknown>)["gtin"] === "07000000000100"
    );
    expect(thisProduct.length).toBe(1);

    // At least one pricing observation must have been written for the admitted product.
    const pricingRows = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(
        and(
          eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID),
          eq(schema.catalogPricingObservations.productId, result.productId!)
        )
      );
    expect(pricingRows.length).toBeGreaterThan(0);
  });

  test("2. unknown channel + new product — staged (channel unresolved → pricing stripped → gate blocks on pricing.primary)", async () => {
    // Unknown channel: pricing/inventory observations stripped before
    // writeAdapterOutput is called. The base fixture DOES produce a
    // category_path observation (productType="Widgets") and a brand
    // (vendor="TestBrand"), so those gate fields are satisfied. The actual
    // gate trigger is pricing.primary — stripping observations removes the
    // only pricing row, so the CANONICAL_MINIMUM gate fails and the product
    // lands in staged_products. The key invariant is that the ingest does NOT
    // throw (drain swallow-and-warn remains reliable).
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

    expect(result.outcome).toBe("staged");
    expect(result.channelResolved).toBe(false);
    expect(result.productId).toBeNull();
    expect(result.stagedProductId).not.toBeNull();

    // No catalog row written (staged, not admitted).
    const products = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    const thisProduct = products.filter(
      (p) => typeof p.identity === "object" && p.identity !== null &&
        (p.identity as Record<string, unknown>)["gtin"] === "07000000000200"
    );
    expect(thisProduct.length).toBe(0);
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

    // Existing live product matched by GTIN → enriched path (bypasses gate).
    expect(result.outcome).toBe("enriched");
    expect(result.productId).toBe(seededId);
    expect(result.stagedProductId).toBeNull();
    expect(result.channelResolved).toBe(true);

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

    // Regression guard: the enriched path must write side-table observations.
    // The fixture carries one variant with price "19.99" AUD and inventoryQuantity 8,
    // so both pricing and inventory rows must be present after enrichment.
    const enrichedPricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(
        and(
          eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID),
          eq(schema.catalogPricingObservations.productId, seededId)
        )
      );
    expect(enrichedPricing.length).toBeGreaterThan(0);

    const enrichedInventory = await db
      .select()
      .from(schema.catalogInventoryObservations)
      .where(
        and(
          eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID),
          eq(schema.catalogInventoryObservations.productId, seededId)
        )
      );
    expect(enrichedInventory.length).toBeGreaterThan(0);
  });

  test("5. resolveShopifyChannel is case-insensitive on region", async () => {
    // Seeded channel is (shopify, "au" lowercase, "schema-tests"). A
    // production drain runs with SHOPIFY_DEFAULT_REGION="AU" (uppercase) —
    // case-sensitive eq() would silently miss. Prove the resolver normalizes.
    const lowercaseRowUpperQuery = await resolveShopifyChannel(
      db,
      TENANT,
      TEST_SHOP_DOMAIN,
      "AU"
    );
    expect(lowercaseRowUpperQuery).not.toBeNull();
    expect(String(lowercaseRowUpperQuery!.channelId)).toBe(TEST_CHANNEL_ID);

    // Inverse: insert a channel with uppercase-stored region, query lowercase.
    const UPPERCASE_CHANNEL_ID = "00000000-0000-0000-0000-0000000000aa";
    const UPPERCASE_ACCOUNT_REF = "uppercase-shop";
    await db
      .insert(schema.channels)
      .values({
        channelId: UPPERCASE_CHANNEL_ID,
        tenantId: TEST_TENANT_ID,
        channelKind: "shopify",
        region: "US", // uppercase, like bootstrap-channels writes
        accountRef: UPPERCASE_ACCOUNT_REF,
        defaultCurrency: "USD",
        defaultLocale: "en_US",
        displayName: "Uppercase-region test channel",
      })
      .onConflictDoNothing();

    try {
      const uppercaseRowLowerQuery = await resolveShopifyChannel(
        db,
        TENANT,
        UPPERCASE_ACCOUNT_REF,
        "us"
      );
      expect(uppercaseRowLowerQuery).not.toBeNull();
      expect(String(uppercaseRowLowerQuery!.channelId)).toBe(UPPERCASE_CHANNEL_ID);
    } finally {
      await db
        .delete(schema.channels)
        .where(eq(schema.channels.channelId, UPPERCASE_CHANNEL_ID));
    }
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
