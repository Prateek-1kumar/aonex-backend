// Tests for the catalog handler dual-path GET /products/:id (Task 4.4).
//
// Strategy: build a real Hono app using `catalogRoutes(deps)`, prepend a
// tiny middleware that stamps `tenantId` / `merchantId` on the context
// (so we don't need JWT machinery), then exercise it via `app.request()`.
// Database is the real dev DB via `@aonex/db/testing`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_MERCHANT_ID,
  TEST_TENANT_ID,
  TEST_CHANNEL_ID,
  closeTestDb,
  connectTestDb,
  ensureTestChannel,
  ensureTestMerchant,
  ensureTestTenant,
} from "@aonex/db/testing";
import { catalogRoutes } from "../routes/catalog.js";

// A second tenant id for cross-tenant 404 tests. We never seed a row in
// `tenants` for this one — tenant FKs on catalog_products require it to
// exist, so for the cross-tenant test we seed under TEST_TENANT_ID and
// then make the *requester* identify as this other tenant.
const OTHER_TENANT_ID = "00000000-0000-0000-0000-0000000000ff";

// A second merchant id for cross-merchant 404 tests (within the SAME
// tenant). Same pattern as OTHER_TENANT_ID — we never seed merchants
// under this id; we only use it to identify the *requester*. The seeded
// product still lives under TEST_MERCHANT_ID, and the handler enforces
// the merchant boundary by mapping a tenant-match-but-merchant-mismatch
// row to a 404 (per `getProductById`'s explicit check).
const OTHER_MERCHANT_ID = "00000000-0000-0000-0000-0000000000fe";

// Stable UUIDs for the legacy-path seed (separate from any production data).
// We deliberately seed a product with NO current_version_id — that
// exercises the legacy handler path's "no version" branch (current_version
// = null, variants = []) without needing to spin up the heavy
// proposed_diffs / extracted_fact_sets / policy_versions chain that an
// approved version requires.
const LEGACY_PRODUCT_ID = "11111111-1111-1111-1111-111111111101";

// Stable UUIDs for the new-catalog seed.
const NEW_PRODUCT_ID = "22222222-2222-2222-2222-222222222201";
const NEW_PRODUCT_ID_STRONG = "22222222-2222-2222-2222-222222222202";

function buildApp(opts: {
  db: DrizzleClient;
  useNewCatalogSchema: boolean;
  tenantId?: string;
  merchantId?: string;
}): Hono {
  const root = new Hono();
  root.use("*", async (c, next) => {
    // @ts-expect-error — same pattern as authMiddleware: untyped context vars.
    c.set("tenantId", opts.tenantId ?? TEST_TENANT_ID);
    // @ts-expect-error — same pattern as authMiddleware.
    c.set("merchantId", opts.merchantId ?? TEST_MERCHANT_ID);
    await next();
  });
  root.route(
    "/catalog",
    catalogRoutes({
      db: opts.db,
      useNewCatalogSchema: opts.useNewCatalogSchema,
    })
  );
  return root;
}

async function fullCleanup(db: DrizzleClient): Promise<void> {
  // Side tables first (FK constraints).
  await db
    .delete(schema.catalogPricingCurrent)
    .where(eq(schema.catalogPricingCurrent.channelId, TEST_CHANNEL_ID));
  await db
    .delete(schema.catalogInventoryCurrent)
    .where(eq(schema.catalogInventoryCurrent.channelId, TEST_CHANNEL_ID));

  // catalog_products: clean any test row by id.
  for (const id of [NEW_PRODUCT_ID, NEW_PRODUCT_ID_STRONG]) {
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, id));
  }

  // Legacy-path tables: clean by id. We only seed `products` (no version,
  // no variants), so the cleanup is just one DELETE.
  await db.execute(sql`DELETE FROM products WHERE id = ${LEGACY_PRODUCT_ID}`);
}

async function seedLegacyProduct(db: DrizzleClient): Promise<void> {
  // We deliberately seed a `products` row with NO currentVersionId. That
  // exercises the legacy handler's "no version" branch (current_version =
  // null, variants = []) WITHOUT requiring the full
  // proposed_diff → policy_version → extracted_fact_set chain that an
  // approved product_version FK demands. The legacy path's response shape
  // contract (product fields + current_version + variants) is what we're
  // asserting here — not the version contents themselves. The
  // legacy/canonical-truth flow is exercised end-to-end elsewhere
  // (catalog-service integration tests).
  await db.insert(schema.products).values({
    id: LEGACY_PRODUCT_ID,
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    status: "active",
  });
}

async function seedNewProduct(
  db: DrizzleClient,
  productId: string,
  winningValues: Record<string, unknown>
): Promise<void> {
  await db.insert(schema.catalogProducts).values({
    productId,
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    primaryIdentifier: `TEST-${productId.slice(-6)}`,
    identity: { brand: "TestBrand", identityStrength: 1.0 },
    status: "active",
    values: {},
    winningValues,
  });
}

describe("GET /products/:id — dual-path catalog handler (Task 4.4)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
  });

  beforeEach(async () => {
    await fullCleanup(db);
  });

  afterAll(async () => {
    await fullCleanup(db);
    await closeTestDb();
  });

  // ---- 1. Flag OFF — legacy path -----------------------------------------

  test("flag OFF — returns legacy product + current_version + variants shape", async () => {
    await seedLegacyProduct(db);

    const app = buildApp({ db, useNewCatalogSchema: false });
    const res = await app.request(`/catalog/products/${LEGACY_PRODUCT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id: string;
        tenantId: string;
        current_version: unknown;
        variants: unknown[];
      };
    };
    expect(body.data.id).toBe(LEGACY_PRODUCT_ID);
    expect(body.data.tenantId).toBe(TEST_TENANT_ID);
    // No version seeded — handler returns current_version=null + variants=[].
    expect(body.data.current_version).toBeNull();
    expect(Array.isArray(body.data.variants)).toBe(true);
    expect(body.data.variants).toEqual([]);
    // Legacy path doesn't emit `winning_values` or `consistency`.
    expect("winning_values" in body.data).toBe(false);
    expect("consistency" in body.data).toBe(false);
  });

  // ---- 2. Flag ON — eventual (default) -----------------------------------

  test("flag ON, default (eventual) — returns winning_values JSONB as stored", async () => {
    const winningValues = {
      _meta: {
        reconciler_version: 1,
        rules_version: 1,
        computed_at: "2026-05-21T00:00:00Z",
      },
      title: {
        _primary: {
          _unscoped: { value: "Test Widget Eventual" },
        },
      },
      pricing: {
        _primary: {
          _unscoped: { currency: "AUD", amount: "9.95", source: "cached" },
        },
      },
    };
    await seedNewProduct(db, NEW_PRODUCT_ID, winningValues);

    const app = buildApp({ db, useNewCatalogSchema: true });
    const res = await app.request(`/catalog/products/${NEW_PRODUCT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        product_id: string;
        tenant_id: string;
        winning_values: Record<string, unknown>;
        consistency: string;
      };
    };
    expect(body.data.product_id).toBe(NEW_PRODUCT_ID);
    expect(body.data.tenant_id).toBe(TEST_TENANT_ID);
    expect(body.data.consistency).toBe("eventual");
    // Shape is as-stored — no transformation.
    const title = body.data.winning_values.title as {
      _primary: { _unscoped: { value: string } };
    };
    expect(title._primary._unscoped.value).toBe("Test Widget Eventual");
    // The cached pricing leaf is the "cached" sentinel; strong mode would
    // replace it with side-table rows.
    const pricing = body.data.winning_values.pricing as {
      _primary: { _unscoped: { source: string } };
    };
    expect(pricing._primary._unscoped.source).toBe("cached");
  });

  // ---- 3. Flag ON — strong -----------------------------------------------

  test("flag ON, ?consistency=strong — overlays catalog_pricing_current + catalog_inventory_current onto reconciler-shape nested objects", async () => {
    // Seed the cached winning_values with the SAME nested shape the
    // reconciler writes: { [channelId]: { [locale|locKey]: <leaf> } }.
    // Strong mode must overlay-by-key, not replace wholesale, so we use
    // a DIFFERENT channelId in the cached block to verify it survives.
    const OTHER_CHANNEL_ID = "00000000-0000-0000-0000-00000000aaaa";
    const winningValues = {
      _meta: { reconciler_version: "v1", rules_version: 1 },
      pricing: {
        [TEST_CHANNEL_ID]: {
          _unscoped: {
            source: "cached-stale",
            currency: "AUD",
            tiers: [{ price: 1.0, currency: "AUD" }],
            pricePerUnit: null,
            observedAt: "2026-05-20T00:00:00.000Z",
          },
        },
        // A second channel that has NO row in catalog_pricing_current —
        // the overlay must not drop it.
        [OTHER_CHANNEL_ID]: {
          _unscoped: {
            source: "cached-only",
            currency: "USD",
            tiers: [{ price: 5.0, currency: "USD" }],
            pricePerUnit: null,
            observedAt: "2026-05-20T00:00:00.000Z",
          },
        },
      },
      inventory: {
        [TEST_CHANNEL_ID]: {
          // Sentinel UUID for NULL location — what the reconciler writes.
          "00000000-0000-0000-0000-000000000000": {
            source: "cached-stale",
            qty: 0,
            clickCollectEligible: true,
            purchaseLimit: 5,
            backorderAllowed: false,
            observedAt: "2026-05-20T00:00:00.000Z",
          },
        },
      },
    };
    await seedNewProduct(db, NEW_PRODUCT_ID_STRONG, winningValues);

    // Seed the side tables with FRESH data that should override the cached
    // winning_values leaves on the matching (channel, locale|loc) keys.
    await db.insert(schema.catalogPricingCurrent).values({
      productId: NEW_PRODUCT_ID_STRONG,
      channelId: TEST_CHANNEL_ID,
      locale: "_unscoped",
      source: "live",
      currency: "AUD",
      tiers: [{ price: 42.5, currency: "AUD" }],
      primaryAmount: "42.50",
      observedAt: new Date("2026-05-21T01:00:00Z"),
    });
    await db.insert(schema.catalogInventoryCurrent).values({
      productId: NEW_PRODUCT_ID_STRONG,
      channelId: TEST_CHANNEL_ID,
      qty: 7,
      source: "live",
      observedAt: new Date("2026-05-21T01:00:00Z"),
    });

    const app = buildApp({ db, useNewCatalogSchema: true });
    const res = await app.request(
      `/catalog/products/${NEW_PRODUCT_ID_STRONG}?consistency=strong`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        product_id: string;
        winning_values: {
          _meta?: unknown;
          pricing: Record<string, Record<string, {
            source: string;
            currency: string;
            primaryAmount?: string | null;
            tiers: unknown;
            pricePerUnit: unknown;
            observedAt: string;
          }>>;
          inventory: Record<string, Record<string, {
            source: string;
            qty: number;
            observedAt: string;
            clickCollectEligible?: boolean | null;
          }>>;
        };
        consistency: string;
      };
    };
    expect(body.data.consistency).toBe("strong");

    // ---- pricing: outer key is channelId UUID, inner key is locale --
    const pricing = body.data.winning_values.pricing;
    // Live row overlays the cached one on (TEST_CHANNEL_ID, _unscoped).
    expect(pricing[TEST_CHANNEL_ID]).toBeTruthy();
    expect(pricing[TEST_CHANNEL_ID]!["_unscoped"]).toBeTruthy();
    expect(pricing[TEST_CHANNEL_ID]!["_unscoped"]!.source).toBe("live");
    expect(pricing[TEST_CHANNEL_ID]!["_unscoped"]!.currency).toBe("AUD");
    // Strong-mode leaf carries primaryAmount from the side table.
    expect(pricing[TEST_CHANNEL_ID]!["_unscoped"]!.primaryAmount).toBe("42.50");
    // The cached-only channel survives the overlay.
    expect(pricing[OTHER_CHANNEL_ID]).toBeTruthy();
    expect(pricing[OTHER_CHANNEL_ID]!["_unscoped"]!.source).toBe("cached-only");

    // ---- inventory: outer key is channelId UUID, inner key is locKey -
    // For NULL location_id the locKey is the sentinel UUID.
    const inventory = body.data.winning_values.inventory;
    expect(inventory[TEST_CHANNEL_ID]).toBeTruthy();
    const invLeaf = inventory[TEST_CHANNEL_ID]!["00000000-0000-0000-0000-000000000000"]!;
    expect(invLeaf).toBeTruthy();
    expect(invLeaf.source).toBe("live");
    expect(invLeaf.qty).toBe(7);
    // Cached-only extras on the same (channel, loc) survive the merge
    // because the side table doesn't store them. (clickCollectEligible
    // was on the cached leaf — but the live overlay leaf REPLACES the
    // cached leaf at that exact inner key, so this is undefined. That's
    // by-design: a stale extras value on a leaf that has a fresh primary
    // should not bleed in. The overlay is per-leaf, not per-field.)
    expect("clickCollectEligible" in invLeaf).toBe(false);

    // _meta is preserved untouched.
    expect(body.data.winning_values._meta).toBeTruthy();
  });

  // ---- 4. Cross-tenant 404 -----------------------------------------------

  test("flag ON — returns 404 when product belongs to a different tenant", async () => {
    await seedNewProduct(db, NEW_PRODUCT_ID, {
      _meta: {},
      title: { _primary: { _unscoped: { value: "Owner A" } } },
    });

    // Requester identifies as a DIFFERENT tenant.
    const app = buildApp({
      db,
      useNewCatalogSchema: true,
      tenantId: OTHER_TENANT_ID,
    });
    const res = await app.request(`/catalog/products/${NEW_PRODUCT_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  // ---- 4b. Cross-merchant 404 -------------------------------------------

  test("flag ON — returns 404 when product belongs to a different merchant in the same tenant", async () => {
    // Seed under TEST_TENANT_ID + TEST_MERCHANT_ID, then request as the
    // SAME tenant but a DIFFERENT merchant. The helper's tenant filter
    // would still let this row through (it's the right tenant), so the
    // handler's explicit `view.merchant_id !== merchantId` check is what
    // we're exercising here — that boundary is load-bearing and must be
    // covered separately from the cross-tenant case.
    await seedNewProduct(db, NEW_PRODUCT_ID, {
      _meta: {},
      title: { _primary: { _unscoped: { value: "Merchant A only" } } },
    });

    const app = buildApp({
      db,
      useNewCatalogSchema: true,
      // Same tenant, different merchant. We don't have to seed
      // OTHER_MERCHANT_ID into `merchants` because it's only used to
      // identify the *requester* — no FK is touched on the request path.
      merchantId: OTHER_MERCHANT_ID,
    });
    const res = await app.request(`/catalog/products/${NEW_PRODUCT_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  // ---- 5. Not found ------------------------------------------------------

  test("flag ON — returns 404 for an unknown product id", async () => {
    const app = buildApp({ db, useNewCatalogSchema: true });
    const res = await app.request(
      "/catalog/products/99999999-9999-9999-9999-999999999999"
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  // ---- 6. Invalid consistency value → 400 -------------------------------

  test("flag ON — returns 400 for an invalid ?consistency value", async () => {
    await seedNewProduct(db, NEW_PRODUCT_ID, { _meta: {} });
    const app = buildApp({ db, useNewCatalogSchema: true });
    const res = await app.request(
      `/catalog/products/${NEW_PRODUCT_ID}?consistency=garbage`
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_QUERY");
  });
});

// ===========================================================================
// GET /products — listProducts new-schema path (Phase 8 prereq A, Task 8.1)
// ===========================================================================
//
// Verifies the new dual-path in listProducts: when `useNewCatalogSchema=true`,
// the handler reads from `catalog_products` and projects into the
// legacy-compatible envelope (id, title, brand, gtin, status, updated_at,
// current_version=null, variants=[], _meta.schema="new").
//
// Test strategy: use the same buildApp/seedNewProduct helpers from above.
// Each test seeds catalog_products rows and exercises the list endpoint.

// Stable UUIDs for list-path tests (distinct from getById tests above).
const LIST_PRODUCT_A = "33333333-3333-3333-3333-333333333301";
const LIST_PRODUCT_B = "33333333-3333-3333-3333-333333333302";

/**
 * winning_values shape for a product with known title/brand/gtin.
 * Mirrors the backfill output shape:
 *   { attr: { _unscoped: { _unscoped: { value: "..." } } } }
 */
function makeWinningValues(fields: {
  title?: string;
  brand?: string;
  gtin?: string;
}): Record<string, unknown> {
  const result: Record<string, unknown> = { _meta: { reconciler_version: 1 } };
  for (const [attr, val] of Object.entries(fields)) {
    if (val !== undefined) {
      result[attr] = { _unscoped: { _unscoped: { value: val } } };
    }
  }
  return result;
}

describe("GET /products — listProducts new-schema path (Phase 8 prereq A)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
  });

  beforeEach(async () => {
    // Clean up list-test rows
    for (const id of [LIST_PRODUCT_A, LIST_PRODUCT_B]) {
      await db
        .delete(schema.catalogProducts)
        .where(eq(schema.catalogProducts.productId, id));
    }
  });

  afterAll(async () => {
    for (const id of [LIST_PRODUCT_A, LIST_PRODUCT_B]) {
      await db
        .delete(schema.catalogProducts)
        .where(eq(schema.catalogProducts.productId, id));
    }
    await closeTestDb();
  });

  // ---- 1. Flag ON — new product appears in list with projected fields -----

  test("flag ON — seeded catalog_products row appears with projected title/brand/gtin/status", async () => {
    await seedNewProduct(
      db,
      LIST_PRODUCT_A,
      makeWinningValues({ title: "Widget Pro", brand: "Acme", gtin: "12345678" })
    );

    const app = buildApp({ db, useNewCatalogSchema: true });
    const res = await app.request("/catalog/products");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        products: Array<{
          id: string;
          title: string | null;
          brand: string | null;
          gtin: string | null;
          status: string;
          current_version: unknown;
          variants: unknown[];
          _meta: { schema: string };
        }>;
      };
    };

    const found = body.data.products.find((p) => p.id === LIST_PRODUCT_A);
    expect(found).toBeTruthy();
    expect(found!.title).toBe("Widget Pro");
    expect(found!.brand).toBe("Acme");
    expect(found!.gtin).toBe("12345678");
    expect(found!.status).toBe("active");
    // Contract: current_version is null for new-schema rows.
    expect(found!.current_version).toBeNull();
    // Contract: variants is [] for new-schema rows (deferred per Phase 7).
    expect(found!.variants).toEqual([]);
    // Migration signal.
    expect(found!._meta.schema).toBe("new");
  });

  // ---- 2. Flag ON — empty list when no catalog_products rows -------------

  test("flag ON — returns empty products array when no catalog_products rows exist", async () => {
    // Don't seed anything for this merchant in this test.
    const app = buildApp({ db, useNewCatalogSchema: true });
    const res = await app.request("/catalog/products");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { products: unknown[] } };
    // May contain rows seeded in other tests that weren't cleaned; assert
    // that the specific test IDs are absent rather than expecting empty.
    const ids = body.data.products.map((p) => (p as { id: string }).id);
    expect(ids).not.toContain(LIST_PRODUCT_A);
    expect(ids).not.toContain(LIST_PRODUCT_B);
  });

  // ---- 3. Flag ON — cross-tenant isolation (requester as OTHER_TENANT) ---

  test("flag ON — catalog_products seeded under TEST_TENANT_ID not visible to other tenant", async () => {
    await seedNewProduct(
      db,
      LIST_PRODUCT_A,
      makeWinningValues({ title: "Tenant A Widget" })
    );

    // Request as OTHER_TENANT_ID — should not see TEST_TENANT_ID's rows.
    const app = buildApp({
      db,
      useNewCatalogSchema: true,
      tenantId: OTHER_TENANT_ID,
    });
    const res = await app.request("/catalog/products");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { products: Array<{ id: string }> } };
    const ids = body.data.products.map((p) => p.id);
    expect(ids).not.toContain(LIST_PRODUCT_A);
  });

  // ---- 4. Flag OFF — legacy path unchanged (regression guard) ------------

  test("flag OFF — list still reads from legacy products table (regression)", async () => {
    // Seed a legacy product (no current_version).
    await db.insert(schema.products).values({
      id: LEGACY_PRODUCT_ID,
      tenantId: TEST_TENANT_ID,
      merchantId: TEST_MERCHANT_ID,
      status: "active",
    });

    const app = buildApp({ db, useNewCatalogSchema: false });
    const res = await app.request("/catalog/products");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { products: Array<{ id: string }> } };
    const ids = body.data.products.map((p) => p.id);
    expect(ids).toContain(LEGACY_PRODUCT_ID);

    // Legacy products must NOT appear with _meta.schema="new"
    const legacyRow = body.data.products.find((p) => p.id === LEGACY_PRODUCT_ID);
    expect(legacyRow).toBeTruthy();
    expect("_meta" in legacyRow!).toBe(false);

    // Cleanup
    await db.execute(sql`DELETE FROM products WHERE id = ${LEGACY_PRODUCT_ID}`);
  });
});
