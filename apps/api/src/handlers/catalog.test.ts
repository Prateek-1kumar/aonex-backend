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

  test("flag ON, ?consistency=strong — JOINs catalog_pricing_current + catalog_inventory_current", async () => {
    const winningValues = {
      _meta: { reconciler_version: 1, rules_version: 1 },
      pricing: {
        _primary: {
          _unscoped: { currency: "AUD", amount: "1.00", source: "cached-stale" },
        },
      },
      inventory: {
        _primary: {
          _unscoped: { qty: 0, source: "cached-stale" },
        },
      },
    };
    await seedNewProduct(db, NEW_PRODUCT_ID_STRONG, winningValues);

    // Seed the side tables with FRESH data that should override the cached
    // winning_values leaves.
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
        winning_values: Record<string, unknown>;
        consistency: string;
      };
    };
    expect(body.data.consistency).toBe("strong");

    // Pricing/inventory leaves are now the joined rows (arrays), NOT the
    // cached `_primary._unscoped` shape.
    expect(Array.isArray(body.data.winning_values.pricing)).toBe(true);
    const pricing = body.data.winning_values.pricing as Array<{
      product_id?: string;
      productId?: string;
      currency: string;
      source: string;
    }>;
    expect(pricing.length).toBe(1);
    expect(pricing[0]!.currency).toBe("AUD");
    expect(pricing[0]!.source).toBe("live");

    expect(Array.isArray(body.data.winning_values.inventory)).toBe(true);
    const inventory = body.data.winning_values.inventory as Array<{
      qty: number;
      source: string;
    }>;
    expect(inventory.length).toBe(1);
    expect(inventory[0]!.qty).toBe(7);
    expect(inventory[0]!.source).toBe("live");

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
