// Tests for the new-schema link ingestion helper (Task 4.2).
//
// Verifies the NEW path that runs under the `useNewCatalogSchema` flag —
// distinct from the legacy `persistLinkCatalogPipeline`. Each test exercises
// the helper directly against the real dev DB so failures point at the
// catalog-write integration, not at LLM/fetcher behaviour.

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
import type { ArtifactId, ChannelId, MerchantId, TenantId } from "@aonex/types";
import type { SkuJson } from "@aonex/ingestion-enrichment";
import { channelCodeFromUrl } from "@aonex/catalog-source-adapters";
import { resolveChannelByCode, runNewLinkCatalogPath } from "./new-catalog-link-path.js";

const TENANT = TEST_TENANT_ID as unknown as TenantId;
const MERCHANT = TEST_MERCHANT_ID as unknown as MerchantId;
const CHANNEL = TEST_CHANNEL_ID as unknown as ChannelId;

const TEST_ACTOR = "test:new-catalog-link-path";

// ---- Helpers ---------------------------------------------------------------

function emptySku(overrides: Partial<SkuJson> = {}): SkuJson {
  return {
    title: null,
    brand: null,
    gtin: null,
    mpn: null,
    model_number: null,
    sku: null,
    description_short: null,
    description_long: null,
    highlights: [],
    category_path: null,
    category_confidence: 0,
    breadcrumbs: [],
    pricing: {
      list_price: null,
      sale_price: null,
      currency: null,
      discount_percent: null,
      price_per_unit: null,
    },
    ratings: { average: null, count: null },
    seller: { name: null, is_official: null },
    images: [],
    options: [],
    variants: [],
    attributes: {},
    shipping: {
      free_shipping: null,
      shipping_cost: null,
      weight: null,
      dimensions: null,
    },
    warranty: null,
    return_policy: null,
    _field_confidence: {},
    _field_source: {},
    _extraction_meta: {
      passes_run: [],
      tokens_used: 0,
      cost_usd: 0,
      latency_ms: 0,
      escalated_to: "static",
    },
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

describe("runNewLinkCatalogPath (Task 4.2)", () => {
  let db: DrizzleClient;

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

  test("1. happy path — creates product, pricing observation, revision, event", async () => {
    // category_path is required by the CANONICAL_MINIMUM gate for admission.
    const sku = emptySku({
      title: "Acme Widget XL",
      brand: "Acme",
      gtin: "07000000000001",
      category_path: "Home & Garden > Tools",
      category_confidence: 0.9,
      pricing: {
        list_price: 99.95,
        sale_price: 79.95,
        currency: "AUD",
        discount_percent: null,
        price_per_unit: null,
      },
      _field_confidence: { title: 0.9, brand: 0.95, gtin: 0.95 },
    });

    // Use the seeded test channel — its channelCode under channelCodeFromUrl
    // would be "shopify-test-au" for shop_domain-style URLs, but we're going
    // to inject channelCode explicitly so the test isn't coupled to host
    // parsing nuances. The helper accepts an explicit `channelCode` arg.
    const result = await runNewLinkCatalogPath({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      artifactId: "00000000-0000-0000-0000-0000000abc01" as unknown as ArtifactId,
      sourceUrl: "https://shop.example-test-au.com/product/widget-xl",
      sku,
      channelId: CHANNEL,
      channelCode: "shop-example-test-au-com",
      channelDefaultCurrency: "AUD",
      channelDefaultLocale: "en_AU",
    });

    // Complete product → admitted (written directly to catalog_products).
    expect(result.outcome).toBe("admitted");
    expect(result.productId).toBeDefined();
    expect(result.stagedProductId).toBeNull();

    // catalog_products
    const products = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, result.productId!));
    expect(products.length).toBe(1);

    // catalog_pricing_observations — 1 row tied to seeded channel
    const pricing = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, result.productId!));
    expect(pricing.length).toBe(1);
    expect(pricing[0]!.channelId).toBe(TEST_CHANNEL_ID);
    expect(pricing[0]!.currency).toBe("AUD");

    // catalog_product_revisions
    const revisions = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(
        and(
          eq(schema.catalogProductRevisions.productId, result.productId!),
          eq(schema.catalogProductRevisions.tenantId, TEST_TENANT_ID)
        )
      );
    expect(revisions.length).toBe(1);
    expect(revisions[0]!.revisionReason).toBe("create");
    expect(revisions[0]!.actor).toBe("link:processor");

    // catalog_events
    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(
        and(
          eq(schema.catalogEvents.productId, result.productId!),
          eq(schema.catalogEvents.tenantId, TEST_TENANT_ID)
        )
      );
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("catalog.product.created");
  });

  test("2. unknown channel + incomplete product — ingest held in staged_products (no catalog row)", async () => {
    // This fixture lacks brand and category_path: the gate will block it.
    // The unknown channel also means pricing would be stripped. The key
    // invariant here is that the ingest SUCCEEDS (outcome: "staged") rather
    // than throwing — the product is held in staged_products for review.
    const sku = emptySku({
      title: "Mystery Marketplace Widget",
      gtin: "07000000000002",
      pricing: {
        list_price: 12.5,
        sale_price: null,
        currency: "USD",
        discount_percent: null,
        price_per_unit: null,
      },
      _field_confidence: { title: 0.8, gtin: 0.9 },
    });

    const result = await runNewLinkCatalogPath({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      artifactId: "00000000-0000-0000-0000-0000000abc02" as unknown as ArtifactId,
      sourceUrl: "https://unknown-marketplace.example/product/abc",
      sku,
      // No channel found — caller passes null.
      channelId: null,
      channelCode: null,
      channelDefaultCurrency: null,
      channelDefaultLocale: null,
    });

    // Incomplete product (no brand, no category_path) → staged, not admitted.
    expect(result.outcome).toBe("staged");
    expect(result.productId).toBeNull();
    expect(result.stagedProductId).not.toBeNull();

    // No catalog product row (the product is in staged_products, not catalog_products).
    const products = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    // Only previously admitted products should exist; none for this GTIN.
    const thisProduct = products.filter(
      (p) => typeof p.identity === "object" && p.identity !== null &&
        (p.identity as Record<string, unknown>)["gtin"] === "07000000000002"
    );
    expect(thisProduct.length).toBe(0);
  });

  test("3. attaches to existing product by GTIN — no new product row, new revision + event", async () => {
    const gtin = "07000000000003";
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

    const sku = emptySku({
      title: "Existing Product, New Source",
      gtin,
      pricing: {
        list_price: 49.99,
        sale_price: null,
        currency: "AUD",
        discount_percent: null,
        price_per_unit: null,
      },
      _field_confidence: { title: 0.9, gtin: 0.95 },
    });

    const result = await runNewLinkCatalogPath({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      artifactId: "00000000-0000-0000-0000-0000000abc03" as unknown as ArtifactId,
      sourceUrl: "https://shop.example-test-au.com/product/existing",
      sku,
      channelId: CHANNEL,
      channelCode: "shop-example-test-au-com",
      channelDefaultCurrency: "AUD",
      channelDefaultLocale: "en_AU",
    });

    // Existing live product matched by GTIN → enriched path (bypasses gate).
    expect(result.outcome).toBe("enriched");
    expect(result.productId).toBe(seededId);
    expect(result.stagedProductId).toBeNull();

    const after = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    expect(Number(after[0]!.count)).toBe(beforeCount);

    const revisions = await db
      .select()
      .from(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.productId, seededId));
    // Should have a revision for this ingest — exactly 1 since we cleaned up.
    expect(revisions.length).toBe(1);
    expect(revisions[0]!.revisionReason).toBe("new_source");

    const events = await db
      .select()
      .from(schema.catalogEvents)
      .where(eq(schema.catalogEvents.productId, seededId));
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("catalog.product.updated");
  });

  test("4. resolveChannelByCode rejects arbitrary host prefixes (allow-list)", async () => {
    // channelCodeFromUrl emits `<host-dotreplaced>` for non-marketplace hosts.
    // A random blog URL must NOT resolve to any channel row even if the
    // tenant happens to have a channel whose kind matches by coincidence
    // (e.g. an "ebay-typo.com" host would otherwise prefix-match "ebay").
    const blogCode = channelCodeFromUrl("https://random-blog.example.io/product");
    expect(blogCode).toBe("random-blog-example-io");
    const blogResolved = await resolveChannelByCode(db, TENANT, blogCode);
    expect(blogResolved).toBeNull();

    // Likewise, a typo'd marketplace host (note: leading prefix is in the
    // allow-list — "ebay" — but there's no seeded ebay channel for this
    // tenant). Verifies the second branch (allow-listed kind, no row).
    const ebayTypoCode = channelCodeFromUrl("https://ebay-typo.com/product");
    // Hostname doesn't start with "ebay." so the adapter falls through to
    // the generic dot-to-hyphen rule, producing "ebay-typo-com".
    expect(ebayTypoCode).toBe("ebay-typo-com");
    const ebayResolved = await resolveChannelByCode(db, TENANT, ebayTypoCode);
    expect(ebayResolved).toBeNull();
  });

  test("5. SkuJson with list_price + null currency under unresolved channel does not throw", async () => {
    // Pre-Fix #2 regression: when channelId=null and SkuJson had
    // pricing.list_price but no currency, the adapter threw before the
    // post-adapt strip helper could fire ("linkAdapter: pricing currency
    // missing..."). The fix pre-strips pricing from the SkuJson BEFORE
    // calling the adapter, so the throw site is unreachable. Verifies
    // the product row + revision + event still land with zero pricing rows.
    const sku = emptySku({
      title: "Currency-less Mystery Widget",
      gtin: "07000000000005",
      pricing: {
        list_price: 99,
        sale_price: null,
        currency: null, // critical — would throw under the old strip-after-adapt flow.
        discount_percent: null,
        price_per_unit: null,
      },
      _field_confidence: { title: 0.8, gtin: 0.9 },
    });

    const result = await runNewLinkCatalogPath({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      artifactId: "00000000-0000-0000-0000-0000000abc05" as unknown as ArtifactId,
      sourceUrl: "https://random-blog.example.io/product/no-currency",
      sku,
      channelId: null,
      channelCode: null,
      channelDefaultCurrency: null,
      channelDefaultLocale: null,
    });

    // Key regression: must NOT throw despite null currency + unresolved channel.
    // Incomplete product (no brand, no category_path) → staged, not admitted.
    expect(result.outcome).toBe("staged");
    expect(result.productId).toBeNull();
    expect(result.stagedProductId).not.toBeNull();
  });
});
