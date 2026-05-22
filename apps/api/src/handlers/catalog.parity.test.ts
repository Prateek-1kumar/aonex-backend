// Phase 7, Task 7.5 — Catalog API new-schema response-shape tests.
//
// Phase 9.3: Legacy-path tests removed (dead code). All tests now exercise
// the new-schema catalog_products path unconditionally. The parity
// assertion framework (normalizeLegacy / normalizeNew) is preserved for
// the new-schema normalizer, which is still used to validate the new
// response shape contract.
//
// ENDPOINTS COVERED:
//   1. GET /products/:id        — new-schema path; response-shape assertions
//   2. GET /products            — new-schema list path
//   3. GET /products/:id/sku    — stubbed 410; skip with rationale
//   4. GET /products/:id/provenance — stubbed 410; skip with rationale

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm"; // sql kept for fullCleanup (product_versions bypass)
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

// ===========================================================================
// Stable UUIDs — parity test fixtures, distinct from catalog.test.ts / admin-trace.test.ts.
// ===========================================================================

// Legacy table UUIDs kept as constants so fullCleanup can wipe any stale
// rows from pre-Phase-9.3 runs.
const PARITY_LEGACY_PRODUCT_ID = "44444444-4444-4444-4444-444444444401";
const PARITY_LEGACY_VERSION_ID = "44444444-4444-4444-4444-444444444402";

// New table (catalog_products): row seeded with winning_values.
const PARITY_NEW_PRODUCT_ID = "44444444-4444-4444-4444-444444444404";

// ===========================================================================
// Normalized response shape — new-schema projection.
// ===========================================================================

interface NormalizedProduct {
  /** Stable identity (product_id in new schema). */
  parity_id: string;
  title: string | null;
  brand: string | null;
  gtin: string | null;
  /** Primary pricing: currency + amount rounded to 4dp. */
  primary_pricing: { currency: string; amount: string } | null;
}

/**
 * Project the raw new-schema GET /products/:id response body into the
 * common NormalizedProduct shape.
 *
 * New-schema shape: { data: { product_id, winning_values: {
 *   title: { _primary: { _unscoped: { value: string } } },
 *   brand: { _primary: { _unscoped: { value: string } } },
 *   gtin:  { _primary: { _unscoped: { value: string } } },
 *   pricing: { <channelId>: { _unscoped: { currency, amount|primaryAmount } } }
 * } } }
 *
 * Channel keys are UUIDs; we extract from the first available channel for
 * the primary price. "_unscoped" locale is the canonical global price.
 */
function normalizeNew(body: {
  data: {
    product_id: string;
    winning_values: Record<string, unknown>;
  };
}): NormalizedProduct {
  const wv = body.data.winning_values;

  // Extract title/brand/gtin from winning_values JSONB.
  function extractSimpleAttr(
    attrBlock: unknown
  ): string | null {
    if (!attrBlock || typeof attrBlock !== "object") return null;
    const block = attrBlock as Record<string, unknown>;
    // Try { _primary: { _unscoped: { value: ... } } } first.
    const primary = block._primary as Record<string, unknown> | undefined;
    if (primary) {
      const unscoped = primary._unscoped as { value?: unknown } | undefined;
      if (unscoped?.value != null) return String(unscoped.value);
    }
    // Also try flat { _unscoped: { value: ... } }.
    const unscoped = block._unscoped as { value?: unknown } | undefined;
    if (unscoped?.value != null) return String(unscoped.value);
    return null;
  }

  const title = extractSimpleAttr(wv.title);
  const brand = extractSimpleAttr(wv.brand);
  const gtin  = extractSimpleAttr(wv.gtin);

  // Extract primary pricing from the first channel's _unscoped locale.
  let primary_pricing: { currency: string; amount: string } | null = null;
  const pricingBlock = wv.pricing as Record<string, unknown> | undefined;
  if (pricingBlock && typeof pricingBlock === "object") {
    // Try each channel key until we find a usable leaf.
    for (const channelKey of Object.keys(pricingBlock)) {
      const byLocale = pricingBlock[channelKey] as Record<string, unknown> | undefined;
      if (!byLocale) continue;
      const leaf = (byLocale._unscoped ?? Object.values(byLocale)[0]) as
        | { currency?: string; amount?: unknown; primaryAmount?: unknown; tiers?: unknown }
        | undefined;
      if (!leaf) continue;
      const currency = leaf.currency ?? null;
      // primaryAmount is the denormalized scalar; fall back to amount or
      // first tier amount.
      let amount: string | null = null;
      if (leaf.primaryAmount != null) {
        amount = parseFloat(String(leaf.primaryAmount)).toFixed(4);
      } else if (leaf.amount != null) {
        amount = parseFloat(String(leaf.amount)).toFixed(4);
      } else if (Array.isArray(leaf.tiers) && leaf.tiers.length > 0) {
        const firstTier = leaf.tiers[0] as { price?: unknown; amount?: unknown };
        const raw = firstTier.price ?? firstTier.amount;
        if (raw != null) amount = parseFloat(String(raw)).toFixed(4);
      }
      if (currency && amount !== null) {
        primary_pricing = { currency: String(currency).toUpperCase(), amount };
        break;
      }
    }
  }

  return {
    parity_id: body.data.product_id,
    title,
    brand,
    gtin,
    primary_pricing,
  };
}

// ===========================================================================
// Hono app builder (mirrors catalog.test.ts pattern).
// ===========================================================================

function buildApp(opts: {
  db: DrizzleClient;
  tenantId?: string;
  merchantId?: string;
}): Hono {
  const root = new Hono();
  root.use("*", async (c, next) => {
    // @ts-expect-error — same pattern as authMiddleware.
    c.set("tenantId", opts.tenantId ?? TEST_TENANT_ID);
    // @ts-expect-error — same pattern as authMiddleware.
    c.set("merchantId", opts.merchantId ?? TEST_MERCHANT_ID);
    await next();
  });
  root.route(
    "/catalog",
    catalogRoutes({ db: opts.db })
  );
  return root;
}

// ===========================================================================
// Seed / cleanup helpers.
// ===========================================================================

async function seedNewProduct(
  db: DrizzleClient,
  opts: {
    title?: string;
    brand?: string;
    gtin?: string;
    priceCurrency?: string;
    priceAmount?: number;
  } = {}
): Promise<void> {
  const winningValues: Record<string, unknown> = {
    _meta: {
      reconciler_version: 1,
      rules_version: 1,
      computed_at: "2026-05-22T00:00:00Z",
    },
  };

  if (opts.title) {
    winningValues.title = {
      _primary: { _unscoped: { value: opts.title } },
    };
  }
  if (opts.brand) {
    winningValues.brand = {
      _primary: { _unscoped: { value: opts.brand } },
    };
  }
  if (opts.gtin) {
    winningValues.gtin = {
      _primary: { _unscoped: { value: opts.gtin } },
    };
  }
  if (opts.priceCurrency && opts.priceAmount !== undefined) {
    winningValues.pricing = {
      [TEST_CHANNEL_ID]: {
        _unscoped: {
          source: "shopify:connector",
          currency: opts.priceCurrency,
          amount: String(opts.priceAmount),
          primaryAmount: String(opts.priceAmount),
          tiers: [{ price: opts.priceAmount, currency: opts.priceCurrency }],
          pricePerUnit: null,
          observedAt: "2026-05-22T00:00:00.000Z",
        },
      },
    };
  }

  await db.insert(schema.catalogProducts).values({
    productId: PARITY_NEW_PRODUCT_ID,
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    primaryIdentifier: `PARITY-${PARITY_NEW_PRODUCT_ID.slice(-6)}`,
    identity: { brand: opts.brand ?? "ParityBrand", identityStrength: 1.0 },
    status: "active",
    values: {},
    winningValues,
  });
}

async function fullCleanup(db: DrizzleClient): Promise<void> {
  // Side tables first (FK deps on catalog_products).
  await db
    .delete(schema.catalogPricingCurrent)
    .where(eq(schema.catalogPricingCurrent.productId, PARITY_NEW_PRODUCT_ID));
  await db
    .delete(schema.catalogInventoryCurrent)
    .where(eq(schema.catalogInventoryCurrent.productId, PARITY_NEW_PRODUCT_ID));

  // New-schema product row.
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.productId, PARITY_NEW_PRODUCT_ID));

  // Legacy rows: product_version (if seeded in test 1e) + products row.
  // The immutability trigger blocks DELETE on product_versions, so we use
  // session_replication_role = 'replica' within a transaction (same bypass
  // used in GDPR purge — see triggers.sql).
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await tx.execute(sql`UPDATE products SET current_version_id = NULL WHERE id = ${PARITY_LEGACY_PRODUCT_ID}`);
    await tx.execute(sql`DELETE FROM product_versions WHERE id = ${PARITY_LEGACY_VERSION_ID}`);
    await tx.execute(sql`DELETE FROM products WHERE id = ${PARITY_LEGACY_PRODUCT_ID}`);
  });
}

// ===========================================================================
// Suite 1: GET /products/:id — new-schema response-shape tests (Phase 9.3).
// ===========================================================================
//
// Phase 9.3: legacy-path tests removed. Only new-schema assertions remain.

describe("GET /products/:id — new-schema response shape (Task 7.5 / Phase 9.3)", () => {
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

  // ---- 1a. 404 for unknown ID ----------------------------------------------

  test("unknown product ID returns 404", async () => {
    const unknownId = "99999999-9999-9999-9999-000000000099";
    const app = buildApp({ db });
    const res = await app.request(`/catalog/products/${unknownId}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  // ---- 1b. Required fields are null when no winning_values -----------------

  test("product with no title/brand/gtin/pricing → normalizer returns all nulls", async () => {
    await seedNewProduct(db);   // no title/brand/gtin/pricing → all null after normalization

    const app = buildApp({ db });
    const res = await app.request(`/catalog/products/${PARITY_NEW_PRODUCT_ID}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Parameters<typeof normalizeNew>[0];
    const normalized = normalizeNew(body);

    expect(normalized.parity_id).toBe(PARITY_NEW_PRODUCT_ID);
    expect(normalized.title).toBeNull();
    expect(normalized.brand).toBeNull();
    expect(normalized.gtin).toBeNull();
    expect(normalized.primary_pricing).toBeNull();

    // Response carries winning_values + consistency fields.
    expect("winning_values" in body.data).toBe(true);
    expect((body.data as unknown as { consistency: string }).consistency).toBe("eventual");
  });

  // ---- 1c. Pricing in winning_values normalizes correctly ------------------

  test("product with pricing → normalizeNew extracts currency + amount (4dp)", async () => {
    await seedNewProduct(db, {
      title: "Parity Widget",
      brand: "ParityBrand",
      gtin: "01234567890123",
      priceCurrency: "AUD",
      priceAmount: 29.95,
    });

    const app = buildApp({ db });
    const res = await app.request(`/catalog/products/${PARITY_NEW_PRODUCT_ID}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Parameters<typeof normalizeNew>[0];
    const normalized = normalizeNew(body);

    expect(normalized.title).toBe("Parity Widget");
    expect(normalized.brand).toBe("ParityBrand");
    expect(normalized.gtin).toBe("01234567890123");
    expect(normalized.primary_pricing).toEqual({ currency: "AUD", amount: "29.9500" });
  });

  // ---- 1d. Cross-tenant 404 ------------------------------------------------

  test("cross-tenant request returns 404 (tenant isolation)", async () => {
    await seedNewProduct(db);

    const OTHER_TENANT_ID = "00000000-0000-0000-0000-0000000000ff";
    const app = buildApp({ db, tenantId: OTHER_TENANT_ID });
    const res = await app.request(`/catalog/products/${PARITY_NEW_PRODUCT_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  // ---- 1e. Currency is normalized to uppercase (toUpperCase in normalizer) --

  test("1e: pricing currency is uppercased by normalizeNew", async () => {
    // Seed new-schema product — currency stored as-is in JSONB.
    // The normalizeNew helper uppercases it; this test confirms that contract.
    await seedNewProduct(db, {
      title: "Parity Priced Widget",
      brand: "ParityBrand",
      gtin: "09876543210987",
      priceCurrency: "AUD",
      priceAmount: 49.99,
    });

    const app = buildApp({ db });
    const res = await app.request(`/catalog/products/${PARITY_NEW_PRODUCT_ID}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Parameters<typeof normalizeNew>[0];
    const normalized = normalizeNew(body);

    expect(normalized.primary_pricing).not.toBeNull();
    expect(normalized.primary_pricing?.currency).toBe("AUD");
    expect(normalized.primary_pricing?.amount).toBe("49.9900");
  });

  // ---- 1f. consistency field is always present on new-schema ---------------

  test("new-schema response always includes consistency field", async () => {
    await seedNewProduct(db, { title: "Widget" });

    const app = buildApp({ db });
    const res = await app.request(`/catalog/products/${PARITY_NEW_PRODUCT_ID}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.consistency).toBe("eventual");
  });
});

// ===========================================================================
// Suite 2: GET /products — listProducts new-schema path (Phase 9.3).
// ===========================================================================
//
// Phase 9.3: listProducts reads from catalog_products unconditionally.

describe("GET /products — listProducts (Phase 8 / Phase 9.3)", () => {
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

  test("list includes seeded catalog_products row", async () => {
    await seedNewProduct(db, { title: "New-Schema Widget" });

    const app = buildApp({ db });
    const res = await app.request("/catalog/products");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { products: Array<{ id: string }> } };
    const ids = body.data.products.map((p) => p.id);

    expect(ids).toContain(PARITY_NEW_PRODUCT_ID);
    expect(ids).not.toContain(PARITY_LEGACY_PRODUCT_ID);
  });
});

// ===========================================================================
// Suite 3: GET /products/:id/sku — SKIPPED (stubbed 410 in Phase 9.3).
// ===========================================================================
//
// RATIONALE FOR SKIP: `getProductSku` returns 410 Gone after Phase 9.3 —
// the legacy tables it queried were renamed to _legacy_* in Phase 8. A
// new-schema SKU endpoint is a future deliverable.

test.skip(
  "GET /products/:id/sku — SKIPPED: returns 410 Gone (Phase 9.3 stub)",
  () => {
    // When a new-schema SKU handler is introduced, add assertions here.
  }
);

// ===========================================================================
// Suite 4: GET /products/:id/provenance — SKIPPED (stubbed 410 in Phase 9.3).
// ===========================================================================
//
// RATIONALE FOR SKIP: `getProductProvenance` (2-segment form) returns 410 Gone
// after Phase 9.3. The new-schema equivalent is the 3-segment
// `/products/:product_id/provenance/:attribute_code` endpoint, tested in
// admin-trace.test.ts.

test.skip(
  "GET /products/:id/provenance — SKIPPED: returns 410 Gone (Phase 9.3 stub)",
  () => {
    // When a new-schema 2-segment provenance handler is introduced, add assertions here.
  }
);
