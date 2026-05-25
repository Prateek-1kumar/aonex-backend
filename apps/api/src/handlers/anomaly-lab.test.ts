import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { schema, type DrizzleClient } from "@aonex/db";
import {
  connectTestDb,
  closeTestDb,
  ensureTestTenant,
  ensureTestMerchant,
  TEST_TENANT_ID,
  TEST_MERCHANT_ID,
} from "@aonex/db/testing";
import { eq, sql } from "drizzle-orm";
import { anomalyLabRoutes } from "../routes/anomaly-lab.js";

// TENANT / OTHER are FK-free (staged_products has no tenant FK) — kept as-is
// for the Task 1 queue tests. Task 2 tests that join catalog_products (which
// has real FK constraints) use TEST_TENANT_ID / TEST_MERCHANT_ID instead.
const TENANT = "d1000000-0000-4000-8000-000000000001";
const OTHER = "d1000000-0000-4000-8000-0000000000ff";

// ── Task 3 constants ────────────────────────────────────────────────────────
// Dedicated tenant for approve/reject/link action endpoint tests.
// Never collides with:
//   TEST_TENANT_ID         "00000000-…-0001"
//   PROMOTE_TENANT_ID      "d0000000-…-0099"  (promote-staged.test.ts)
//   REJECT_TENANT_ID       "f0000000-…-0099"  (reject-staged.test.ts)
//   LINK_TENANT_ID         "e0000000-…-0099"  (link-staged.test.ts)
const ACTION_TENANT_ID = "a1000000-0000-0000-0000-000000000099";
const ACTION_MERCHANT_ID = "a1000000-0000-0000-0000-000000000097";
const ACTION_CHANNEL_ID = "a1000000-0000-0000-0000-000000000098";
const ACTION_CHANNEL_CODE = "shopify-au"; // channelKind=shopify, region=au
const ACTION_TEST_ACTOR = "test:anomaly-lab-http-actions";

// Stable UUIDs for Task 2 fixtures — deterministic cleanup in afterAll.
const LAB_CATALOG_PRODUCT_ID = "ee000000-0000-4000-8000-000000000001";
const LAB_STAGED_CAND_ID = "ee000000-0000-4000-8000-000000000002"; // staged-kind candidate (no catalog row)
const LAB_STAGED_WITH_LIVE_CAND = "ee000000-0000-4000-8000-000000000010";
const LAB_STAGED_CROSS_TENANT = "ee000000-0000-4000-8000-000000000011";
const LAB_STAGED_EVIDENCE = "ee000000-0000-4000-8000-000000000012";
const LAB_STAGED_NO_ARTIFACT = "ee000000-0000-4000-8000-000000000013";
// source_artifacts unique key: (merchantId, sourceMarketplace, sourceExternalId, checksum)
// We give it a stable sourceExternalId + checksum so cleanup is safe.
const LAB_ARTIFACT_EXTERNAL_ID = "lab-test-evidence-url-0001";
const LAB_ARTIFACT_CHECKSUM = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let db: DrizzleClient;
let labArtifactId: string; // assigned during beforeAll, used in staged-evidence test

function buildApp(tenantId = TENANT) {
  const root = new Hono();
  root.use("*", async (c, next) => {
    c.set("tenantId" as never, tenantId as never);
    c.set("merchantId" as never, tenantId as never);
    await next();
  });
  root.route("/api/lab", anomalyLabRoutes({ db, audit: { emit: async () => {} } as never }));
  return root;
}

async function insertStaged(tenantId: string, status: string, title: string, missing: string[]) {
  const [row] = await db.insert(schema.stagedProducts).values({
    tenantId, merchantId: tenantId,
    proposedIdentity: {}, observations: { observations: [], pricingObservations: [], inventoryObservations: [], identityHint: { targetIsVariant: false }, rawPayload: {} },
    denormTitle: title, sourceKind: "link",
    gateVerdict: { missingFields: missing, signals: [] }, matchCandidates: [], status
  } as never).returning({ id: schema.stagedProducts.stagedProductId });
  return row!.id;
}

beforeAll(async () => {
  db = await connectTestDb();

  // Task 1 seeding (FK-free).
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT));
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, OTHER));
  await insertStaged(TENANT, "pending", "Pending One", ["brand"]);
  await insertStaged(TENANT, "pending", "Pending Two", ["identifier"]);
  await insertStaged(TENANT, "promoted", "Done", []);
  await insertStaged(OTHER, "pending", "Other Tenant", ["brand"]);

  // Task 2 seeding — needs real FK rows for catalog_products + source_artifacts.
  await ensureTestTenant(db);
  await ensureTestMerchant(db);

  // Clean up any leftover Task 2 fixtures from prior runs.
  await db.delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.stagedProductId, LAB_STAGED_WITH_LIVE_CAND));
  await db.delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.stagedProductId, LAB_STAGED_CROSS_TENANT));
  await db.delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.stagedProductId, LAB_STAGED_EVIDENCE));
  await db.delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.stagedProductId, LAB_STAGED_NO_ARTIFACT));
  await db.delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.productId, LAB_CATALOG_PRODUCT_ID));
  // source_artifacts cleanup: by stable external id (unique constraint key)
  await db.delete(schema.sourceArtifacts).where(
    eq(schema.sourceArtifacts.sourceExternalId, LAB_ARTIFACT_EXTERNAL_ID)
  );

  // Seed a live catalog product (title + brand in expected shape).
  await db.insert(schema.catalogProducts).values({
    productId: LAB_CATALOG_PRODUCT_ID,
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    primaryIdentifier: "LAB-TEST-CP-0001",
    identity: { brand: "LabBrand" },
    status: "active",
    values: {},
    winningValues: { title: { _primary: { value: "Lab Widget Pro" } } },
  });

  // Seed a source artifact for evidence test.
  const [artifactRow] = await db.insert(schema.sourceArtifacts).values({
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    sourceType: "link_url",
    sourceMarketplace: "shopify",
    sourceExternalId: LAB_ARTIFACT_EXTERNAL_ID,
    rawData: {
      url: "https://example.com/lab-widget",
      finalUrl: "https://example.com/lab-widget",
      statusCode: 200,
      contentType: "text/html",
      fetchedAt: "2026-05-25T00:00:00.000Z",
      htmlSnippet: "<html><body>Lab Widget Pro product page</body></html>",
      cleanedTextLength: 2048,
    },
    checksum: LAB_ARTIFACT_CHECKSUM,
    status: "processing",
  }).returning({ id: schema.sourceArtifacts.id });
  labArtifactId = artifactRow!.id;

  // Staged row with a live match candidate pointing at LAB_CATALOG_PRODUCT_ID.
  await db.insert(schema.stagedProducts).values({
    stagedProductId: LAB_STAGED_WITH_LIVE_CAND,
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    proposedIdentity: { brand: "LabBrand" },
    observations: { observations: [], pricingObservations: [], inventoryObservations: [], identityHint: { targetIsVariant: false }, rawPayload: {} },
    denormTitle: "Lab Widget",
    sourceKind: "link",
    gateVerdict: { missingFields: ["identifier"], signals: [{ kind: "low_confidence" }] },
    matchCandidates: [
      { productId: LAB_CATALOG_PRODUCT_ID, score: 0.6, kind: "live" },
      { productId: LAB_STAGED_CAND_ID, score: 0.4, kind: "staged" },
    ],
    status: "pending",
  } as never);

  // Staged row under TEST_TENANT_ID for cross-tenant 404 test.
  await db.insert(schema.stagedProducts).values({
    stagedProductId: LAB_STAGED_CROSS_TENANT,
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    proposedIdentity: {},
    observations: { observations: [], pricingObservations: [], inventoryObservations: [], identityHint: { targetIsVariant: false }, rawPayload: {} },
    denormTitle: "Cross Tenant Row",
    sourceKind: "link",
    gateVerdict: { missingFields: [], signals: [] },
    matchCandidates: [],
    status: "pending",
  } as never);

  // Staged row with a sourceArtifactId for the evidence test.
  await db.insert(schema.stagedProducts).values({
    stagedProductId: LAB_STAGED_EVIDENCE,
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    proposedIdentity: {},
    observations: { observations: [], pricingObservations: [], inventoryObservations: [], identityHint: { targetIsVariant: false }, rawPayload: {} },
    denormTitle: "Evidence Row",
    sourceKind: "link",
    sourceArtifactId: labArtifactId,
    gateVerdict: { missingFields: ["brand"], signals: [] },
    matchCandidates: [],
    status: "pending",
  } as never);

  // Staged row with null sourceArtifactId for the "kind:none" evidence test.
  await db.insert(schema.stagedProducts).values({
    stagedProductId: LAB_STAGED_NO_ARTIFACT,
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    proposedIdentity: {},
    observations: { observations: [], pricingObservations: [], inventoryObservations: [], identityHint: { targetIsVariant: false }, rawPayload: {} },
    denormTitle: "No Artifact Row",
    sourceKind: "link",
    gateVerdict: { missingFields: [], signals: [] },
    matchCandidates: [],
    status: "pending",
  } as never);

  // ── Task 3 seeding ─────────────────────────────────────────────────────────
  // Dedicated tenant + merchant + channel for the action endpoint integration tests.
  // Mirrors promote-staged.test.ts setup: channelKind=shopify + region=au so the
  // derived code "shopify-au" matches the pricing observation channelCode, allowing
  // promoteStagedProduct to resolve the channel and write the pricing side-table row.
  await db.insert(schema.tenants).values({
    id: ACTION_TENANT_ID,
    name: "Test Tenant (anomaly-lab-http-actions)",
    status: "active",
  }).onConflictDoNothing();

  await db.insert(schema.merchants).values({
    id: ACTION_MERCHANT_ID,
    tenantId: ACTION_TENANT_ID,
    email: "lab-actions@anomaly-lab-http-tests.internal",
    passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only",
    displayName: "Test Merchant (anomaly-lab-http-actions)",
    defaultCurrency: "AUD",
  }).onConflictDoNothing();

  await db.insert(schema.channels).values({
    channelId: ACTION_CHANNEL_ID,
    tenantId: ACTION_TENANT_ID,
    channelKind: "shopify",
    region: "au",
    accountRef: "anomaly-lab-http-tests",
    defaultCurrency: "AUD",
    defaultLocale: "en-AU",
    displayName: "Test Channel (anomaly-lab-http-actions)",
  }).onConflictDoNothing();

  // Source priority rules — writeAdapterOutput needs at least one rule to reconcile.
  await db.insert(schema.sourcePriority).values({
    tenantId: null,
    attributeCode: null,
    sourceGlob: "*",
    channelScope: null,
    priority: 100,
    rulesVersion: 1,
    actor: ACTION_TEST_ACTOR,
  }).onConflictDoNothing();
});

afterAll(async () => {
  // Task 1 cleanup.
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT));
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, OTHER));

  // Task 2 cleanup — order matters: staged rows first, then catalog + artifacts.
  await db.delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.stagedProductId, LAB_STAGED_WITH_LIVE_CAND));
  await db.delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.stagedProductId, LAB_STAGED_CROSS_TENANT));
  await db.delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.stagedProductId, LAB_STAGED_EVIDENCE));
  await db.delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.stagedProductId, LAB_STAGED_NO_ARTIFACT));
  await db.delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.productId, LAB_CATALOG_PRODUCT_ID));
  await db.delete(schema.sourceArtifacts).where(
    eq(schema.sourceArtifacts.sourceExternalId, LAB_ARTIFACT_EXTERNAL_ID)
  );

  // ── Task 3 cleanup ─────────────────────────────────────────────────────────
  // The approve happy-path writes catalog_products / pricing / revision rows.
  // Must disable the immutable-revision trigger, then delete in FK order.

  // reconciliation_overrides (no schema.reconciliationOverrides — use raw sql)
  await db.execute(
    sql`DELETE FROM reconciliation_overrides WHERE product_id IN (
      SELECT product_id FROM catalog_products WHERE tenant_id = ${ACTION_TENANT_ID}
    )`
  );

  // Staged products
  await db.delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.tenantId, ACTION_TENANT_ID));

  // Pricing + inventory side-tables
  await db.delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, ACTION_TENANT_ID));
  await db.delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, ACTION_TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${ACTION_TENANT_ID}`
  );

  // Revisions (immutable trigger)
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`
  );
  await db.delete(schema.catalogProductRevisions)
    .where(eq(schema.catalogProductRevisions.tenantId, ACTION_TENANT_ID));
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`
  );

  // Identity side-effects
  await db.delete(schema.identityLog)
    .where(eq(schema.identityLog.tenantId, ACTION_TENANT_ID));
  await db.delete(schema.reviewTasks)
    .where(eq(schema.reviewTasks.tenantId, ACTION_TENANT_ID));

  // Catalog products
  await db.delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, ACTION_TENANT_ID));

  // Channel
  await db.delete(schema.channels)
    .where(eq(schema.channels.channelId, ACTION_CHANNEL_ID));

  // Source priority rules
  await db.delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, ACTION_TEST_ACTOR));

  // Merchant + tenant (order: merchant first due to FK)
  await db.delete(schema.merchants)
    .where(eq(schema.merchants.id, ACTION_MERCHANT_ID));
  await db.delete(schema.tenants)
    .where(eq(schema.tenants.id, ACTION_TENANT_ID));

  await closeTestDb();
});

test("GET /api/lab/queue returns only pending rows for the tenant", async () => {
  const res = await buildApp().fetch(new Request("http://x/api/lab/queue"));
  expect(res.status).toBe(200);
  const { data } = await res.json() as { data: { items: Array<{ stagedProductId: string; denormTitle: string; missingFields: string[]; candidateCount: number }> } };
  expect(data.items.length).toBe(2);
  expect(data.items.map((i) => i.denormTitle).sort()).toEqual(["Pending One", "Pending Two"]);
  expect(data.items.every((i) => Array.isArray(i.missingFields))).toBe(true);
  expect(data.items.every((i) => i.candidateCount === 0)).toBe(true);
});

test("GET /api/lab/queue/stats returns total + breakdowns", async () => {
  const res = await buildApp().fetch(new Request("http://x/api/lab/queue/stats"));
  expect(res.status).toBe(200);
  const { data } = await res.json() as { data: { total: number; bySource: Record<string, number> } };
  expect(data.total).toBe(2);
  expect(data.bySource["link"]).toBe(2);
});

// ── Task 2 tests ────────────────────────────────────────────────────────────

test("GET /api/lab/staged/:id returns full detail with enriched live candidate", async () => {
  const res = await buildApp(TEST_TENANT_ID).fetch(
    new Request(`http://x/api/lab/staged/${LAB_STAGED_WITH_LIVE_CAND}`)
  );
  expect(res.status).toBe(200);
  const { data } = await res.json() as {
    data: {
      stagedProductId: string;
      sourceKind: string;
      missingFields: string[];
      signals: unknown[];
      matchCandidates: Array<{ productId: string; score: number; kind: string; title: string | null; brand: string | null }>;
    };
  };
  expect(data.stagedProductId).toBe(LAB_STAGED_WITH_LIVE_CAND);
  expect(data.sourceKind).toBe("link");
  expect(data.missingFields).toContain("identifier");
  expect(Array.isArray(data.signals)).toBe(true);
  expect(data.matchCandidates).toHaveLength(2);
  const liveCand = data.matchCandidates.find((c) => c.kind === "live")!;
  expect(liveCand.productId).toBe(LAB_CATALOG_PRODUCT_ID);
  expect(liveCand.score).toBe(0.6);
  // Title and brand from winningValues + identity of the catalog row.
  expect(liveCand.title).toBe("Lab Widget Pro");
  expect(liveCand.brand).toBe("LabBrand");
  // kind:"staged" candidates have no catalog row — must come back with null title/brand.
  const stagedCand = data.matchCandidates.find((c) => c.kind === "staged")!;
  expect(stagedCand.productId).toBe(LAB_STAGED_CAND_ID);
  expect(stagedCand.title).toBeNull();
  expect(stagedCand.brand).toBeNull();
});

test("GET /api/lab/staged/:id cross-tenant returns 404", async () => {
  // LAB_STAGED_CROSS_TENANT lives under TEST_TENANT_ID; request as OTHER tenant.
  const res = await buildApp(OTHER).fetch(
    new Request(`http://x/api/lab/staged/${LAB_STAGED_CROSS_TENANT}`)
  );
  expect(res.status).toBe(404);
});

test("GET /api/lab/staged/:id/evidence returns html kind for link artifact", async () => {
  const res = await buildApp(TEST_TENANT_ID).fetch(
    new Request(`http://x/api/lab/staged/${LAB_STAGED_EVIDENCE}/evidence`)
  );
  expect(res.status).toBe(200);
  const { data } = await res.json() as { data: { kind: string; content: string | null } };
  expect(data.kind).toBe("html");
  expect(typeof data.content).toBe("string");
  expect((data.content as string).length).toBeGreaterThan(0);
});

test("GET /api/lab/staged/:id/evidence returns kind:none when no artifact", async () => {
  const res = await buildApp(TEST_TENANT_ID).fetch(
    new Request(`http://x/api/lab/staged/${LAB_STAGED_NO_ARTIFACT}/evidence`)
  );
  expect(res.status).toBe(200);
  const { data } = await res.json() as { data: { kind: string; content: null } };
  expect(data.kind).toBe("none");
  expect(data.content).toBeNull();
});

test("GET /api/lab/staged/:id/evidence cross-tenant returns 404", async () => {
  // LAB_STAGED_EVIDENCE lives under TEST_TENANT_ID; request as OTHER.
  const res = await buildApp(OTHER).fetch(
    new Request(`http://x/api/lab/staged/${LAB_STAGED_EVIDENCE}/evidence`)
  );
  expect(res.status).toBe(404);
});

// ── Task 3 tests: approve / reject / link action endpoints ─────────────────

/**
 * Build a Hono app scoped to the action test tenant.
 * Sets merchantId to ACTION_MERCHANT_ID so getReviewerId(c) resolves
 * to a known value.
 */
function buildActionApp() {
  const root = new Hono();
  root.use("*", async (c, next) => {
    c.set("tenantId" as never, ACTION_TENANT_ID as never);
    c.set("merchantId" as never, ACTION_MERCHANT_ID as never);
    await next();
  });
  root.route("/api/lab", anomalyLabRoutes({ db, audit: { emit: async () => {} } as never }));
  return root;
}

/**
 * Insert a staged product under ACTION_TENANT_ID that is promotable with fills:
 *   { brand: "Acme", gtin: "4000000000017" }
 *
 * Has a pricing observation on ACTION_CHANNEL_CODE ("shopify-au") so
 * promoteStagedProduct's channel resolution finds ACTION_CHANNEL_ID and
 * writeAdapterOutput can write the catalog_pricing_observations row.
 * Missing brand + identifier → gate fails → staged (not admitted).
 */
async function insertPromotableStagedRow(): Promise<string> {
  // Build observations directly (no stageProduct call needed — we're testing
  // the HTTP handler, not the staging pipeline).
  const observations = {
    observations: [
      {
        attributeCode: "title",
        target: "parent",
        channelCode: ACTION_CHANNEL_CODE,
        localeCode: "en-AU",
        source: "shopify:connector",
        sourceRecordId: "lab-http-promote-001",
        value: "Widget Tee (Lab HTTP Test)",
        confidence: 0.95,
        observedAt: "2026-05-25T10:00:00.000Z",
      },
      {
        attributeCode: "category_path",
        target: "parent",
        channelCode: ACTION_CHANNEL_CODE,
        localeCode: "en-AU",
        source: "shopify:connector",
        sourceRecordId: "lab-http-promote-002",
        value: "Apparel > Tops",
        confidence: 0.95,
        observedAt: "2026-05-25T10:00:00.000Z",
      },
    ],
    pricingObservations: [
      {
        productHint: "widget-tee-lab-http",
        channelCode: ACTION_CHANNEL_CODE,
        locale: "en-AU",
        source: "shopify:connector",
        sourceRecordId: "lab-http-promote-v001",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 39.99 }],
        observedAt: "2026-05-25T10:00:00.000Z",
      },
    ],
    inventoryObservations: [],
    identityHint: { targetIsVariant: false },
    rawPayload: { src: "anomaly-lab-http-test" },
  };

  const [row] = await db.insert(schema.stagedProducts).values({
    tenantId: ACTION_TENANT_ID,
    merchantId: ACTION_MERCHANT_ID,
    proposedIdentity: {},
    observations,
    denormTitle: "Widget Tee (Lab HTTP Test)",
    sourceKind: "shopify",
    gateVerdict: { missingFields: ["brand", "identifier"], signals: [] },
    matchCandidates: [],
    status: "pending",
  } as never).returning({ id: schema.stagedProducts.stagedProductId });
  return row!.id;
}

/**
 * Insert a staged product under ACTION_TENANT_ID with empty observations.
 * Gate verdict: missing both brand + identifier. Used for reject + link tests.
 */
async function insertMinimalStagedRow(matchCandidates: unknown[] = []): Promise<string> {
  const [row] = await db.insert(schema.stagedProducts).values({
    tenantId: ACTION_TENANT_ID,
    merchantId: ACTION_MERCHANT_ID,
    proposedIdentity: {},
    observations: {
      observations: [],
      pricingObservations: [],
      inventoryObservations: [],
      identityHint: { targetIsVariant: false },
      rawPayload: {},
    },
    denormTitle: "Minimal Lab Row",
    sourceKind: "link",
    gateVerdict: { missingFields: ["brand", "identifier"], signals: [] },
    matchCandidates,
    status: "pending",
  } as never).returning({ id: schema.stagedProducts.stagedProductId });
  return row!.id;
}

test("POST /api/lab/staged/:id/approve happy path: 200, body.data.productId, catalog row written", async () => {
  const id = await insertPromotableStagedRow();
  const res = await buildActionApp().fetch(
    new Request(`http://x/api/lab/staged/${id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fills: { brand: "Acme", gtin: "4000000000017" } }),
    })
  );
  expect(res.status).toBe(200);
  const body = await res.json() as { data?: { productId?: string }; error?: unknown };
  expect(body.data).toBeDefined();
  expect(typeof body.data!.productId).toBe("string");

  // Verify catalog_products row was written.
  const productRows = await db
    .select({ productId: schema.catalogProducts.productId })
    .from(schema.catalogProducts)
    .where(eq(schema.catalogProducts.productId, body.data!.productId!));
  expect(productRows.length).toBe(1);
});

test("POST /api/lab/staged/:id/approve still-incomplete: 400, body.error.code INCOMPLETE, stillMissing includes identifier", async () => {
  const id = await insertPromotableStagedRow();
  const res = await buildActionApp().fetch(
    new Request(`http://x/api/lab/staged/${id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fills: {} }), // no fills → brand + identifier missing
    })
  );
  expect(res.status).toBe(400);
  const body = await res.json() as { error?: { code?: string; stillMissing?: string[] } };
  expect(body.error?.code).toBe("INCOMPLETE");
  expect(Array.isArray(body.error?.stillMissing)).toBe(true);
  expect(body.error!.stillMissing).toContain("identifier");
});

test("POST /api/lab/staged/:id/reject: 200, body.data.ok === true, row is rejected", async () => {
  const id = await insertMinimalStagedRow();
  const res = await buildActionApp().fetch(
    new Request(`http://x/api/lab/staged/${id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  );
  expect(res.status).toBe(200);
  const body = await res.json() as { data?: { ok?: boolean } };
  expect(body.data?.ok).toBe(true);

  // Verify the row is now rejected.
  const [staged] = await db
    .select({ status: schema.stagedProducts.status })
    .from(schema.stagedProducts)
    .where(eq(schema.stagedProducts.stagedProductId, id));
  expect(staged?.status).toBe("rejected");
});

test("POST /api/lab/staged/:id/link not-a-candidate: 400, body.error.code BAD_REQUEST", async () => {
  // Staged row with empty matchCandidates.
  const id = await insertMinimalStagedRow([]);
  const someUuid = "99999999-9999-4999-9999-999999999999";
  const res = await buildActionApp().fetch(
    new Request(`http://x/api/lab/staged/${id}/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmedProductId: someUuid }),
    })
  );
  expect(res.status).toBe(400);
  const body = await res.json() as { error?: { code?: string } };
  expect(body.error?.code).toBe("BAD_REQUEST");
});
