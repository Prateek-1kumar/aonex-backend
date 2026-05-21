// Tests for the admin-trace handler (Task 4.5 — provenance trace endpoint).
//
// Endpoint under test:
//   GET /products/:product_id/provenance/:attribute_code?channel=<x>&locale=<y>
//
// Strategy (mirrors `catalog.test.ts`): build a real Hono app via
// `catalogRoutes(deps)`, prepend a tiny middleware that stamps
// `tenantId` / `merchantId` on the context (no JWT machinery needed), then
// exercise it via `app.request()`. Database is the real dev DB via
// `@aonex/db/testing`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
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

// Cross-tenant 404 — same convention as `catalog.test.ts`.
const OTHER_TENANT_ID = "00000000-0000-0000-0000-0000000000ff";
const OTHER_MERCHANT_ID = "00000000-0000-0000-0000-0000000000fe";

// Stable UUIDs for this test file's seeded rows so cleanup is targeted
// (we never touch other tests' rows).
const TRACE_PRODUCT_ID = "33333333-3333-3333-3333-333333333301";
const TRACE_PRODUCT_ID_JSONB = "33333333-3333-3333-3333-333333333302";
const TRACE_PRODUCT_ID_MISSING_ATTR = "33333333-3333-3333-3333-333333333303";

// Marker for source_priority cleanup. Same pattern as
// async-debounced.test.ts — tag rows we insert so we can DELETE them in
// afterAll without disturbing other test files.
const TEST_ACTOR = "test:admin-trace";

function buildApp(opts: {
  db: DrizzleClient;
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
  // The provenance trace endpoint is part of the new-schema admin surface.
  // It is wired ONLY when `useNewCatalogSchema=true`. We always pass true
  // here because every test in this file exercises the new endpoint.
  root.route(
    "/catalog",
    catalogRoutes({ db: opts.db, useNewCatalogSchema: true })
  );
  return root;
}

async function fullCleanup(db: DrizzleClient): Promise<void> {
  // Side tables first (no FK to catalog_products on these test rows but
  // we delete by product_id explicitly for safety).
  for (const id of [
    TRACE_PRODUCT_ID,
    TRACE_PRODUCT_ID_JSONB,
    TRACE_PRODUCT_ID_MISSING_ATTR,
  ]) {
    await db
      .delete(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.productId, id));
    await db
      .delete(schema.catalogInventoryObservations)
      .where(eq(schema.catalogInventoryObservations.productId, id));
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, id));
  }
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

async function seedRules(db: DrizzleClient): Promise<{
  shopifyRuleId: number;
  catchAllRuleId: number;
}> {
  // Shopify wins at priority 1; everything else falls back to the catch-all.
  // Both rules are global (tenantId NULL) and all-attribute (attributeCode NULL),
  // matching the bootstrap convention.
  const rows = await db
    .insert(schema.sourcePriority)
    .values([
      {
        tenantId: null,
        attributeCode: null,
        sourceGlob: "shopify:*",
        channelScope: null,
        priority: 1,
        rulesVersion: 1,
        actor: TEST_ACTOR,
      },
      {
        tenantId: null,
        attributeCode: null,
        sourceGlob: "*",
        channelScope: null,
        priority: 100,
        rulesVersion: 1,
        actor: TEST_ACTOR,
      },
    ])
    .returning();
  return {
    shopifyRuleId: rows[0]!.ruleId,
    catchAllRuleId: rows[1]!.ruleId,
  };
}

async function seedProduct(
  db: DrizzleClient,
  productId: string,
  values: Record<string, unknown>
): Promise<void> {
  await db.insert(schema.catalogProducts).values({
    productId,
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    primaryIdentifier: `TRACE-${productId.slice(-6)}`,
    identity: { brand: "TraceBrand" },
    status: "active",
    values,
    winningValues: {},
  });
}

describe("GET /products/:product_id/provenance/:attribute_code (Task 4.5)", () => {
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

  // ---- 1. Pricing winner via side table -------------------------------------

  test("pricing — winner returns shopify observation + rule that fired", async () => {
    // Seed our own rules under TEST_ACTOR. The dev DB also carries the
    // 19 production-seed global rules (migration 0014/Task 1.11), so
    // assertions below check rule SHAPE (priority=1, glob matches shopify)
    // rather than a specific ruleId — which rule fires depends on
    // pickWinner's tie-breaker order, and is deterministic across runs
    // but not across DB seeds.
    await seedRules(db);
    await seedProduct(db, TRACE_PRODUCT_ID, {});

    // Two observations for the same (channel, locale) leaf, different
    // sources. Shopify rule (priority 1) beats the csv:* fallback.
    const inserted = await db
      .insert(schema.catalogPricingObservations)
      .values([
        {
          productId: TRACE_PRODUCT_ID,
          tenantId: TEST_TENANT_ID,
          channelId: TEST_CHANNEL_ID,
          locale: "en_AU",
          source: "csv:upload",
          currency: "AUD",
          tiers: [{ kind: "list", amount: 110 }],
          observedAt: new Date("2026-05-21T10:00:00Z"),
        },
        {
          productId: TRACE_PRODUCT_ID,
          tenantId: TEST_TENANT_ID,
          channelId: TEST_CHANNEL_ID,
          locale: "en_AU",
          source: "shopify:connector",
          currency: "AUD",
          tiers: [
            { kind: "list", amount: 99.95 },
            { kind: "sale", amount: 79.95 },
          ],
          observedAt: new Date("2026-05-21T09:00:00Z"),
        },
      ])
      .returning();
    const shopifyObsId = inserted.find((r) => r.source === "shopify:connector")!
      .observationId;

    // Channel param is the channel code as the writer emits it
    // (channelKind-region), e.g. "shopify-au" for the test channel.
    const app = buildApp({ db });
    const res = await app.request(
      `/catalog/products/${TRACE_PRODUCT_ID}/provenance/pricing?channel=shopify-au&locale=en_AU`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        attribute: string;
        channel: string;
        locale: string;
        winner: { source: string; currency: string } | null;
        rule_fired: { rule_id: number | string; source_glob: string; priority: number } | null;
        observation_id: number | string | null;
        observation_source: string | null;
        observation_observed_at: string | null;
        artifact_id: string | null;
        raw_payload_pointer: string | null;
      };
    };

    expect(body.data.attribute).toBe("pricing");
    expect(body.data.channel).toBe("shopify-au");
    expect(body.data.locale).toBe("en_AU");
    expect(body.data.winner).not.toBeNull();
    expect(body.data.winner!.source).toBe("shopify:connector");
    expect(body.data.winner!.currency).toBe("AUD");
    expect(body.data.rule_fired).not.toBeNull();
    // SOME shopify-targeting rule at priority 1 fires — exact ruleId
    // depends on DB seed order (our TEST_ACTOR rule or the production
    // seed rule `shopify:connector @ pricing`). Both are valid traces.
    expect(typeof body.data.rule_fired!.rule_id).toBe("number");
    expect(body.data.rule_fired!.source_glob).toMatch(/^shopify:/);
    expect(body.data.rule_fired!.priority).toBe(1);
    expect(body.data.observation_source).toBe("shopify:connector");
    // observation_id is the bigint from catalog_pricing_observations.
    expect(Number(body.data.observation_id)).toBe(Number(shopifyObsId));
    expect(body.data.observation_observed_at).toBe(
      "2026-05-21T09:00:00.000Z"
    );
    // raw_payload_pointer is null in v1 (no object-storage wiring).
    expect(body.data.raw_payload_pointer).toBeNull();
  });

  // ---- 2. JSONB attribute (title) — winner from values ----------------------

  test("title — winner returns from values JSONB; observation_id is null (no row id)", async () => {
    await seedRules(db);
    // Production seed migration 0014/Task 1.11 carries
    // `csv:* @ title @ priority=1` and `shopify:connector @ title @ priority=2`,
    // which would make CSV win for title. We seed a tenant-scoped rule
    // at priority 0 to force a deterministic shopify-wins trace
    // regardless of which global seeds happen to be in the test DB.
    const overrideRule = await db
      .insert(schema.sourcePriority)
      .values({
        tenantId: TEST_TENANT_ID,
        attributeCode: "title",
        sourceGlob: "shopify:*",
        channelScope: null,
        priority: 0,
        rulesVersion: 1,
        actor: TEST_ACTOR,
      })
      .returning();
    const expectedRuleId = overrideRule[0]!.ruleId;
    // For sync attributes the outer key in `values` is the channel CODE
    // (string), not the channel UUID — that's the writer convention. The
    // endpoint passes this string through to pickWinner unchanged.
    await seedProduct(db, TRACE_PRODUCT_ID_JSONB, {
      title: {
        "shopify-au": {
          en_AU: [
            {
              source: "csv:upload",
              source_record_id: "csv#row-5",
              value: "Title B (from CSV)",
              confidence: 0.8,
              observed_at: "2026-05-21T10:00:00.000Z",
            },
            {
              source: "shopify:connector",
              source_record_id: "shop#7",
              value: "Title A (from Shopify)",
              confidence: 0.95,
              observed_at: "2026-05-21T09:00:00.000Z",
              extras: { artifactId: "44444444-4444-4444-4444-444444444444" },
            },
          ],
        },
      },
    });

    const app = buildApp({ db });
    const res = await app.request(
      `/catalog/products/${TRACE_PRODUCT_ID_JSONB}/provenance/title?channel=shopify-au&locale=en_AU`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        attribute: string;
        winner: unknown;
        rule_fired: { rule_id: number; source_glob: string; priority: number } | null;
        observation_id: number | string | null;
        observation_source: string | null;
        observation_observed_at: string | null;
        artifact_id: string | null;
        raw_payload_pointer: string | null;
      };
    };
    expect(body.data.attribute).toBe("title");
    expect(body.data.winner).toBe("Title A (from Shopify)");
    expect(body.data.rule_fired).not.toBeNull();
    expect(body.data.rule_fired!.rule_id).toBe(expectedRuleId);
    expect(body.data.rule_fired!.source_glob).toBe("shopify:*");
    expect(body.data.rule_fired!.priority).toBe(0);
    expect(body.data.observation_source).toBe("shopify:connector");
    // JSONB observations have no row id — observation_id is null.
    expect(body.data.observation_id).toBeNull();
    expect(body.data.observation_observed_at).toBe(
      "2026-05-21T09:00:00.000Z"
    );
    // artifactId from extras flows through.
    expect(body.data.artifact_id).toBe(
      "44444444-4444-4444-4444-444444444444"
    );
    expect(body.data.raw_payload_pointer).toBeNull();
  });

  // ---- 3. Cross-tenant 404 --------------------------------------------------

  test("returns 404 when product belongs to a different tenant", async () => {
    await seedRules(db);
    await seedProduct(db, TRACE_PRODUCT_ID_JSONB, {
      title: {
        _unscoped: { _unscoped: [
          {
            source: "csv:upload",
            source_record_id: "x",
            value: "Hidden",
            confidence: 1,
            observed_at: "2026-05-21T00:00:00.000Z",
          },
        ] },
      },
    });
    const app = buildApp({ db, tenantId: OTHER_TENANT_ID });
    const res = await app.request(
      `/catalog/products/${TRACE_PRODUCT_ID_JSONB}/provenance/title`
    );
    expect(res.status).toBe(404);
  });

  // ---- 4. Cross-merchant 404 ------------------------------------------------

  test("returns 404 when product belongs to a different merchant in the same tenant", async () => {
    await seedRules(db);
    await seedProduct(db, TRACE_PRODUCT_ID_JSONB, {
      title: { _unscoped: { _unscoped: [
        {
          source: "csv:upload",
          source_record_id: "x",
          value: "Hidden",
          confidence: 1,
          observed_at: "2026-05-21T00:00:00.000Z",
        },
      ] } },
    });
    const app = buildApp({
      db,
      merchantId: OTHER_MERCHANT_ID, // same tenant, different merchant
    });
    const res = await app.request(
      `/catalog/products/${TRACE_PRODUCT_ID_JSONB}/provenance/title`
    );
    expect(res.status).toBe(404);
  });

  // ---- 5. Missing product → 404 ---------------------------------------------

  test("returns 404 for a random product id that doesn't exist", async () => {
    const app = buildApp({ db });
    const res = await app.request(
      `/catalog/products/99999999-9999-9999-9999-999999999999/provenance/title`
    );
    expect(res.status).toBe(404);
  });

  // ---- 6. Missing attribute → 200 with null fields --------------------------

  test("returns 200 with winner=null when the product exists but has no observations for that attribute", async () => {
    await seedRules(db);
    await seedProduct(db, TRACE_PRODUCT_ID_MISSING_ATTR, {
      title: { _unscoped: { _unscoped: [
        {
          source: "csv:upload",
          source_record_id: "x",
          value: "Some Title",
          confidence: 1,
          observed_at: "2026-05-21T00:00:00.000Z",
        },
      ] } },
    });
    const app = buildApp({ db });
    // unknown_attr never written → no observations → winner is null.
    const res = await app.request(
      `/catalog/products/${TRACE_PRODUCT_ID_MISSING_ATTR}/provenance/unknown_attr`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        attribute: string;
        winner: unknown;
        rule_fired: unknown;
        observation_id: unknown;
        observation_source: unknown;
      };
    };
    expect(body.data.attribute).toBe("unknown_attr");
    expect(body.data.winner).toBeNull();
    expect(body.data.rule_fired).toBeNull();
    expect(body.data.observation_id).toBeNull();
    expect(body.data.observation_source).toBeNull();
  });

  // ---- 7. Invalid product_id format → 400 -----------------------------------

  test("returns 400 for a non-UUID product_id", async () => {
    const app = buildApp({ db });
    const res = await app.request(
      `/catalog/products/not-a-uuid/provenance/title`
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_PRODUCT_ID");
  });
});
