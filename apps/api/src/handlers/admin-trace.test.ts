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

// Cross-tenant 404 — same convention as `catalog.test.ts`.
const OTHER_TENANT_ID = "00000000-0000-0000-0000-0000000000ff";
const OTHER_MERCHANT_ID = "00000000-0000-0000-0000-0000000000fe";

// Stable UUIDs for this test file's seeded rows so cleanup is targeted
// (we never touch other tests' rows).
const TRACE_PRODUCT_ID = "33333333-3333-3333-3333-333333333301";
const TRACE_PRODUCT_ID_JSONB = "33333333-3333-3333-3333-333333333302";
const TRACE_PRODUCT_ID_MISSING_ATTR = "33333333-3333-3333-3333-333333333303";
// Task 6.1 — product trace endpoint test fixtures. Distinct from the
// 4.5 provenance fixtures above so the two suites can interleave their
// cleanup without stepping on each other.
const TRACE6_PRODUCT_HAPPY = "33333333-3333-3333-3333-333333333310";
const TRACE6_PRODUCT_WINDOW = "33333333-3333-3333-3333-333333333311";
const TRACE6_PRODUCT_REVISIONS = "33333333-3333-3333-3333-333333333312";
const TRACE6_PRODUCT_CROSS_TENANT = "33333333-3333-3333-3333-333333333313";
const TRACE6_PRODUCT_CROSS_MERCHANT = "33333333-3333-3333-3333-333333333314";
const TRACE6_PRODUCT_GROUPING = "33333333-3333-3333-3333-333333333315";

const TRACE6_PRODUCT_IDS = [
  TRACE6_PRODUCT_HAPPY,
  TRACE6_PRODUCT_WINDOW,
  TRACE6_PRODUCT_REVISIONS,
  TRACE6_PRODUCT_CROSS_TENANT,
  TRACE6_PRODUCT_CROSS_MERCHANT,
  TRACE6_PRODUCT_GROUPING,
];

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
  root.route(
    "/catalog",
    catalogRoutes({ db: opts.db })
  );
  return root;
}

async function fullCleanup(db: DrizzleClient): Promise<void> {
  // Side tables first (no FK to catalog_products on these test rows but
  // we delete by product_id explicitly for safety).
  //
  // For Task 6.1 fixtures we also wipe revisions / overrides / events.
  // reconciliation_overrides has ON DELETE CASCADE FK to catalog_products
  // but we delete explicitly anyway so the test seeds are idempotent
  // regardless of FK direction.
  const allIds = [
    TRACE_PRODUCT_ID,
    TRACE_PRODUCT_ID_JSONB,
    TRACE_PRODUCT_ID_MISSING_ATTR,
    ...TRACE6_PRODUCT_IDS,
  ];
  // Revisions table has BEFORE UPDATE/DELETE trigger trg_revisions_immutable
  // (migration 0010) — temporarily disable it to wipe test rows, then
  // re-enable. Same pattern as `packages/catalog/catalog-service/src/merge.test.ts`.
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`
  );
  try {
    for (const id of allIds) {
      await db
        .delete(schema.catalogPricingObservations)
        .where(eq(schema.catalogPricingObservations.productId, id));
      await db
        .delete(schema.catalogInventoryObservations)
        .where(eq(schema.catalogInventoryObservations.productId, id));
      await db
        .delete(schema.catalogProductRevisions)
        .where(eq(schema.catalogProductRevisions.productId, id));
      await db
        .delete(schema.reconciliationOverrides)
        .where(eq(schema.reconciliationOverrides.productId, id));
      await db
        .delete(schema.catalogEvents)
        .where(eq(schema.catalogEvents.productId, id));
      await db
        .delete(schema.catalogProducts)
        .where(eq(schema.catalogProducts.productId, id));
    }
  } finally {
    await db.execute(
      sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`
    );
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

// ===========================================================================
// Task 6.1 — Product Trace endpoint
// ===========================================================================
//
// Endpoint under test:
//   GET /products/:product_id/trace
//     ?since=<iso>
//     &observations_limit=<n> &revisions_limit=<n> &events_limit=<n>
//     &observations_cursor=<iso> &revisions_cursor=<iso> &events_cursor=<iso>
//
// Same harness as the Phase 4.5 suite above — real DB via @aonex/db/testing,
// stub-auth middleware, hit through `app.request()`. The fullCleanup helper
// already wipes the Task 6.1 product IDs so we don't need a separate
// cleanup function.
//
// All seed timestamps stay within May/June 2026 because that's the range
// covered by the static monthly partitions (migrations 0010-0016 create
// partitions for 2026-05/06/07 only). Tests that want "out-of-window"
// behavior use `?since=` to narrow the window rather than seeding rows in
// April or earlier — INSERTs to a non-existent partition would fail.

/**
 * Shared product seed used by the Task 6.1 suite. Defaults to TEST_TENANT_ID
 * + TEST_MERCHANT_ID; callers can override per cross-tenant / cross-merchant
 * cases.
 */
async function seedTraceProduct(
  db: DrizzleClient,
  productId: string,
  opts: {
    values?: Record<string, unknown>;
    winningValues?: Record<string, unknown>;
    tenantId?: string;
    merchantId?: string;
  } = {}
): Promise<void> {
  await db.insert(schema.catalogProducts).values({
    productId,
    tenantId: opts.tenantId ?? TEST_TENANT_ID,
    merchantId: opts.merchantId ?? TEST_MERCHANT_ID,
    primaryIdentifier: `TRACE6-${productId.slice(-6)}`,
    identity: { brand: "TraceBrand" },
    status: "active",
    values: opts.values ?? {},
    winningValues: opts.winningValues ?? {},
  });
}

describe("GET /products/:product_id/trace (Task 6.1)", () => {
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
    // closeTestDb is idempotent (sets the internal singleton to null),
    // so calling it here is safe even though the Phase 4.5 suite's
    // afterAll runs first and already closes the pool. The second call
    // is a no-op — see packages/db/src/testing/connect.ts.
    await closeTestDb();
  });

  // ---- 1. Happy path — full payload ----------------------------------------

  test("happy path — returns product, observations, revisions, overrides, events", async () => {
    const productId = TRACE6_PRODUCT_HAPPY;
    await seedTraceProduct(db, productId);

    // All timestamps are recent (within the default 30-day window). Use
    // distinct, decreasing observed_at so DESC ordering is unambiguous.
    const base = new Date("2026-05-21T12:00:00Z");
    const stamp = (offsetMinutes: number) =>
      new Date(base.getTime() - offsetMinutes * 60 * 1000);

    await db.insert(schema.catalogPricingObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "shopify:connector",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 99 }],
        observedAt: stamp(10),
      },
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "csv:upload",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 100 }],
        observedAt: stamp(20),
      },
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "csv:upload",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 110 }],
        observedAt: stamp(30),
      },
    ]);

    await db.insert(schema.catalogInventoryObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        qty: 5,
        source: "shopify:connector",
        observedAt: stamp(15),
      },
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        qty: 10,
        source: "shopify:connector",
        observedAt: stamp(25),
      },
    ]);

    // 5 revisions at 5 distinct ingested_at within May 2026.
    await db.insert(schema.catalogProductRevisions).values(
      [1, 2, 3, 4, 5].map((i) => ({
        productId,
        tenantId: TEST_TENANT_ID,
        valuesSnapshot: { rev: i },
        revisionReason: `ingest-${i}`,
        ingestedAt: stamp(60 + i * 10),
      }))
    );

    // 1 active override (frozen_until in the future).
    await db.insert(schema.reconciliationOverrides).values({
      productId,
      attributeCode: "title",
      channelCode: "_unscoped",
      localeCode: "_unscoped",
      frozenValue: "Pinned Title",
      frozenUntil: new Date("2026-12-31T00:00:00Z"),
      actor: TEST_ACTOR,
      rationale: "test pin",
    });

    // 4 events.
    await db.insert(schema.catalogEvents).values(
      [1, 2, 3, 4].map((i) => ({
        eventType: "product.upserted",
        productId,
        tenantId: TEST_TENANT_ID,
        payload: { idx: i },
        triggeredBy: TEST_ACTOR,
        occurredAt: stamp(5 + i * 5),
      }))
    );

    const app = buildApp({ db });
    const res = await app.request(`/catalog/products/${productId}/trace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        product: { product_id: string; tenant_id: string; merchant_id: string };
        pricing_observations: unknown[];
        inventory_observations: unknown[];
        revisions: unknown[];
        reconciliation_overrides: unknown[];
        events: unknown[];
        observations_by_attribute: Record<string, unknown>;
        window: { since: string; until: string };
        pagination: {
          observations_next_cursor: string | null;
          revisions_next_cursor: string | null;
          events_next_cursor: string | null;
        };
      };
    };

    expect(body.data.product.product_id).toBe(productId);
    expect(body.data.product.tenant_id).toBe(TEST_TENANT_ID);
    expect(body.data.product.merchant_id).toBe(TEST_MERCHANT_ID);
    expect(body.data.pricing_observations.length).toBe(3);
    expect(body.data.inventory_observations.length).toBe(2);
    expect(body.data.revisions.length).toBe(5);
    expect(body.data.reconciliation_overrides.length).toBe(1);
    expect(body.data.events.length).toBe(4);
    // window.since should be roughly 30 days before window.until.
    const since = new Date(body.data.window.since).getTime();
    const until = new Date(body.data.window.until).getTime();
    const deltaDays = (until - since) / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBeGreaterThan(29.9);
    expect(deltaDays).toBeLessThan(30.1);
    // All sections under their default limits → no next cursors.
    expect(body.data.pagination.observations_next_cursor).toBeNull();
    expect(body.data.pagination.revisions_next_cursor).toBeNull();
    expect(body.data.pagination.events_next_cursor).toBeNull();
  });

  // ---- 2. ?since= override narrows the window -------------------------------

  test("?since= narrows the observation window", async () => {
    const productId = TRACE6_PRODUCT_WINDOW;
    await seedTraceProduct(db, productId);

    // Three observations: 1 within "recent" (last hour), 1 within "midrange"
    // (3 days ago), 1 within "old" (10 days ago, but still within the
    // partition range — see file-level comment for why we don't go back
    // 40 days).
    const now = new Date("2026-05-21T12:00:00Z");
    const recent = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h ago
    const midrange = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3d ago
    const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10d ago

    await db.insert(schema.catalogPricingObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "shopify:connector",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 1 }],
        observedAt: recent,
      },
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "shopify:connector",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 2 }],
        observedAt: midrange,
      },
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "shopify:connector",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 3 }],
        observedAt: old,
      },
    ]);

    // since = 2 days ago → excludes midrange (3d) and old (10d), keeps recent.
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const app = buildApp({ db });
    const res = await app.request(
      `/catalog/products/${productId}/trace?since=${encodeURIComponent(since)}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { pricing_observations: Array<{ tiers: unknown }> };
    };
    expect(body.data.pricing_observations.length).toBe(1);
    // The kept observation is the one at amount=1 (recent).
    const tiers = body.data.pricing_observations[0]!.tiers as Array<{
      amount: number;
    }>;
    expect(tiers[0]!.amount).toBe(1);
  });

  // ---- 3. ?revisions_limit= caps the revisions list -------------------------

  test("?revisions_limit=2 caps revisions and orders by ingestedAt DESC", async () => {
    const productId = TRACE6_PRODUCT_REVISIONS;
    await seedTraceProduct(db, productId);

    const base = new Date("2026-05-21T12:00:00Z").getTime();
    await db.insert(schema.catalogProductRevisions).values(
      [1, 2, 3, 4, 5].map((i) => ({
        productId,
        tenantId: TEST_TENANT_ID,
        valuesSnapshot: { rev: i },
        revisionReason: `rev-${i}`,
        // Each revision 1 hour apart; rev-5 is newest.
        ingestedAt: new Date(base - (5 - i) * 60 * 60 * 1000),
      }))
    );

    const app = buildApp({ db });
    const res = await app.request(
      `/catalog/products/${productId}/trace?revisions_limit=2`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        revisions: Array<{ revision_reason: string; ingested_at: string }>;
        pagination: { revisions_next_cursor: string | null };
      };
    };
    expect(body.data.revisions.length).toBe(2);
    // DESC by ingestedAt → newest first (rev-5, rev-4).
    expect(body.data.revisions[0]!.revision_reason).toBe("rev-5");
    expect(body.data.revisions[1]!.revision_reason).toBe("rev-4");
    // Hit the limit → a cursor is set.
    expect(body.data.pagination.revisions_next_cursor).not.toBeNull();
    // Composite cursor format: <iso>|<id>.
    expect(body.data.pagination.revisions_next_cursor).toMatch(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.Z]+\|[0-9]+$/
    );
  });

  // ---- 4. Revisions pagination cursor follow-up -----------------------------

  test("revisions_cursor returns the next page", async () => {
    const productId = TRACE6_PRODUCT_REVISIONS;
    await seedTraceProduct(db, productId);

    const base = new Date("2026-05-21T12:00:00Z").getTime();
    await db.insert(schema.catalogProductRevisions).values(
      [1, 2, 3, 4, 5].map((i) => ({
        productId,
        tenantId: TEST_TENANT_ID,
        valuesSnapshot: { rev: i },
        revisionReason: `rev-${i}`,
        ingestedAt: new Date(base - (5 - i) * 60 * 60 * 1000),
      }))
    );

    const app = buildApp({ db });
    const firstRes = await app.request(
      `/catalog/products/${productId}/trace?revisions_limit=2`
    );
    const firstBody = (await firstRes.json()) as {
      data: {
        revisions: Array<{ revision_reason: string }>;
        pagination: { revisions_next_cursor: string | null };
      };
    };
    expect(firstBody.data.revisions.map((r) => r.revision_reason)).toEqual([
      "rev-5",
      "rev-4",
    ]);
    const cursor = firstBody.data.pagination.revisions_next_cursor;
    expect(cursor).not.toBeNull();

    const secondRes = await app.request(
      `/catalog/products/${productId}/trace?revisions_limit=2&revisions_cursor=${encodeURIComponent(
        cursor!
      )}`
    );
    const secondBody = (await secondRes.json()) as {
      data: {
        revisions: Array<{ revision_reason: string }>;
        pagination: { revisions_next_cursor: string | null };
      };
    };
    // Next 2 oldest: rev-3, rev-2.
    expect(secondBody.data.revisions.map((r) => r.revision_reason)).toEqual([
      "rev-3",
      "rev-2",
    ]);
  });

  // ---- 5. Cross-tenant 404 --------------------------------------------------

  test("returns 404 when product belongs to a different tenant", async () => {
    const productId = TRACE6_PRODUCT_CROSS_TENANT;
    await seedTraceProduct(db, productId);
    const app = buildApp({ db, tenantId: OTHER_TENANT_ID });
    const res = await app.request(`/catalog/products/${productId}/trace`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  // ---- 6. Cross-merchant 404 ------------------------------------------------

  test("returns 404 when product belongs to a different merchant in the same tenant", async () => {
    const productId = TRACE6_PRODUCT_CROSS_MERCHANT;
    await seedTraceProduct(db, productId);
    const app = buildApp({ db, merchantId: OTHER_MERCHANT_ID });
    const res = await app.request(`/catalog/products/${productId}/trace`);
    expect(res.status).toBe(404);
  });

  // ---- 7. Invalid UUID → 400 ------------------------------------------------

  test("returns 400 for a non-UUID product_id", async () => {
    const app = buildApp({ db });
    const res = await app.request(`/catalog/products/not-a-uuid/trace`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_PRODUCT_ID");
  });

  // ---- 8. Product not found → 404 -------------------------------------------

  test("returns 404 for a valid UUID with no row", async () => {
    const app = buildApp({ db });
    const res = await app.request(
      `/catalog/products/99999999-9999-9999-9999-999999999999/trace`
    );
    expect(res.status).toBe(404);
  });

  // ---- 9. observationsByAttribute grouping ----------------------------------

  test("observationsByAttribute mirrors catalog_products.values nesting", async () => {
    const productId = TRACE6_PRODUCT_GROUPING;
    await seedTraceProduct(db, productId, {
      values: {
        title: {
          "shopify-au": {
            en_AU: [
              {
                source: "shopify:connector",
                source_record_id: "shop#1",
                value: "Shop Title",
                confidence: 0.95,
                observed_at: "2026-05-21T09:00:00.000Z",
              },
            ],
          },
          "magento-au": {
            en_AU: [
              {
                source: "magento:connector",
                source_record_id: "mage#1",
                value: "Mage Title",
                confidence: 0.9,
                observed_at: "2026-05-21T08:00:00.000Z",
              },
            ],
          },
        },
        brand: {
          _unscoped: {
            _unscoped: [
              {
                source: "csv:upload",
                source_record_id: "csv#1",
                value: "ACME",
                confidence: 1,
                observed_at: "2026-05-21T07:00:00.000Z",
              },
            ],
          },
        },
      },
    });

    const app = buildApp({ db });
    const res = await app.request(`/catalog/products/${productId}/trace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        observations_by_attribute: Record<
          string,
          Record<string, Record<string, Array<{ value: unknown }>>>
        >;
      };
    };

    const grouped = body.data.observations_by_attribute;
    expect(Object.keys(grouped).sort()).toEqual(["brand", "title"]);
    // 2 channels × 1 locale on title.
    expect(Array.isArray(grouped.title!["shopify-au"]!.en_AU)).toBe(true);
    expect(grouped.title!["shopify-au"]!.en_AU![0]!.value).toBe("Shop Title");
    expect(grouped.title!["magento-au"]!.en_AU![0]!.value).toBe("Mage Title");
    // brand is _unscoped on both axes.
    expect(grouped.brand!._unscoped!._unscoped![0]!.value).toBe("ACME");
  });

  // ---- 10. Malformed ?since= → 400 INVALID_QUERY ----------------------------

  test("returns 400 INVALID_QUERY for a non-ISO ?since=", async () => {
    const app = buildApp({ db });
    const res = await app.request(
      `/catalog/products/${TRACE6_PRODUCT_HAPPY}/trace?since=not-an-iso`
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_QUERY");
  });

  // ---- 11. Malformed ?revisions_limit= → 400 INVALID_QUERY -----------------

  test("returns 400 INVALID_QUERY for ?revisions_limit=-5", async () => {
    const app = buildApp({ db });
    // Use a negative number — parsePositiveIntQuery rejects on the leading
    // dash via the `/^[0-9]+$/` guard. This proves the parse+clamp error
    // path is wired correctly at the handler boundary, not silently
    // clamped to the default.
    const res = await app.request(
      `/catalog/products/${TRACE6_PRODUCT_HAPPY}/trace?revisions_limit=-5`
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_QUERY");
  });

  // ---- 12. Legacy single-timestamp cursor → 400 INVALID_QUERY --------------

  test("returns 400 INVALID_QUERY for a legacy cursor with no '|' tie-breaker", async () => {
    const app = buildApp({ db });
    // Pre-release we hard-break legacy cursors so clients can't silently
    // half-page when two rows share a timestamp.
    const res = await app.request(
      `/catalog/products/${TRACE6_PRODUCT_HAPPY}/trace?revisions_cursor=2026-05-21T00:00:00.000Z`
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_QUERY");
  });

});
