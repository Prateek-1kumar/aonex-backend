import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { schema, type DrizzleClient } from "@aonex/db";
import { connectTestDb, closeTestDb } from "@aonex/db/testing";
import { eq } from "drizzle-orm";
import { anomalyLabRoutes } from "../routes/anomaly-lab.js";

const TENANT = "d1000000-0000-4000-8000-000000000001";
const OTHER = "d1000000-0000-4000-8000-0000000000ff";
let db: DrizzleClient;

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
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT));
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, OTHER));
  await insertStaged(TENANT, "pending", "Pending One", ["brand"]);
  await insertStaged(TENANT, "pending", "Pending Two", ["identifier"]);
  await insertStaged(TENANT, "promoted", "Done", []);
  await insertStaged(OTHER, "pending", "Other Tenant", ["brand"]);
});

afterAll(async () => {
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT));
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, OTHER));
  await closeTestDb();
});

test("GET /api/lab/queue returns only pending rows for the tenant", async () => {
  const res = await buildApp().fetch(new Request("http://x/api/lab/queue"));
  expect(res.status).toBe(200);
  const body = await res.json() as { items: Array<{ stagedProductId: string; denormTitle: string; missingFields: string[]; candidateCount: number }> };
  expect(body.items.length).toBe(2);
  expect(body.items.map((i) => i.denormTitle).sort()).toEqual(["Pending One", "Pending Two"]);
  expect(body.items.every((i) => Array.isArray(i.missingFields))).toBe(true);
});

test("GET /api/lab/queue/stats returns total + breakdowns", async () => {
  const res = await buildApp().fetch(new Request("http://x/api/lab/queue/stats"));
  expect(res.status).toBe(200);
  const body = await res.json() as { total: number; bySource: Record<string, number> };
  expect(body.total).toBe(2);
  expect(body.bySource["link"]).toBe(2);
});
