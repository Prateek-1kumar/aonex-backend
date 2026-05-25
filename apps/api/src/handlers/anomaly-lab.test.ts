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
import { eq } from "drizzle-orm";
import { anomalyLabRoutes } from "../routes/anomaly-lab.js";

// TENANT / OTHER are FK-free (staged_products has no tenant FK) — kept as-is
// for the Task 1 queue tests. Task 2 tests that join catalog_products (which
// has real FK constraints) use TEST_TENANT_ID / TEST_MERCHANT_ID instead.
const TENANT = "d1000000-0000-4000-8000-000000000001";
const OTHER = "d1000000-0000-4000-8000-0000000000ff";

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
