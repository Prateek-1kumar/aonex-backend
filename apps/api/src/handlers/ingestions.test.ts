import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import { QUEUE } from "@aonex/types";
import {
  connectTestDb, closeTestDb, ensureTestTenant, ensureTestMerchant,
  TEST_TENANT_ID, TEST_MERCHANT_ID,
} from "@aonex/db/testing";
import { ingestionsRoutes } from "../routes/ingestions.js";

function buildApp(db: DrizzleClient, enqueued: any[]): Hono {
  const fakeQueue = { add: async (name: string, data: any) => { enqueued.push({ name, data }); return { id: "job1" }; } } as any;
  const root = new Hono();
  root.use("*", async (c, next) => {
    // @ts-expect-error untyped context vars (same pattern as authMiddleware)
    c.set("tenantId", TEST_TENANT_ID); // @ts-expect-error
    c.set("merchantId", TEST_MERCHANT_ID); await next();
  });
  root.route("/ingestions", ingestionsRoutes({
    db, audit: { emit: async () => {} } as any,
    queues: { [QUEUE.LINK_EXTRACT]: fakeQueue, [QUEUE.CSV_PARSE]: fakeQueue },
  }));
  return root;
}

describe("POST /ingestions/csv", () => {
  let db: DrizzleClient;
  beforeAll(async () => { db = await connectTestDb(); await ensureTestTenant(db); await ensureTestMerchant(db); });
  afterAll(async () => { await closeTestDb(); }); // closeTestDb takes NO args

  test("accepts a CSV, persists a file artifact, enqueues a parse job", async () => {
    const enqueued: any[] = [];
    const app = buildApp(db, enqueued);
    const HEADER = "primary_identifier,brand,title,currency,list_price";
    const csv = [HEADER, "UP-1,Acme,Widget,USD,19.99"].join("\n");
    const form = new FormData();
    form.append("file", new File([csv], "products.csv", { type: "text/csv" }));

    const res = await app.request("/ingestions/csv", { method: "POST", body: form });
    expect(res.status).toBe(202);
    const body = await res.json() as { data: { rowCount: number; ingestionId: string; status: string } };
    expect(body.data.rowCount).toBe(1);
    expect(typeof body.data.ingestionId).toBe("string");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].name).toBe("csv-parse");

    const artifact = await db.query.sourceArtifacts.findFirst({ where: (a, { eq }) => eq(a.id, body.data.ingestionId) });
    expect(artifact!.sourceType).toBe("templated_csv");
    expect(artifact!.status).toBe("pending");
  });

  test("rejects a non-CSV file with 415", async () => {
    const app = buildApp(db, []);
    const form = new FormData();
    form.append("file", new File(["%PDF-1.4"], "x.pdf", { type: "application/pdf" }));
    const res = await app.request("/ingestions/csv", { method: "POST", body: form });
    expect(res.status).toBe(415);
  });

  test("rejects a CSV missing primary_identifier with 422", async () => {
    const app = buildApp(db, []);
    const form = new FormData();
    form.append("file", new File(["brand,title\nAcme,Widget"], "x.csv", { type: "text/csv" }));
    const res = await app.request("/ingestions/csv", { method: "POST", body: form });
    expect(res.status).toBe(422);
  });

  test("recent + trace expose CSV file status and error report", async () => {
    const enqueued: any[] = [];
    const app = buildApp(db, enqueued);
    const HEADER = "primary_identifier,brand,title,currency,list_price";
    const csv = [HEADER, "REC-1,Acme,Widget,USD,19.99", "REC-2,,,USD,5.00"].join("\n");
    const form = new FormData();
    form.append("file", new File([csv], "rep.csv", { type: "text/csv" }));
    const up = await (await app.request("/ingestions/csv", { method: "POST", body: form })).json() as any;

    // Simulate the worker writing the report (the processor itself is covered in Task 3).
    await db.update(schema.sourceArtifacts)
      .set({ status: "needs_review", processingErrors: [{ row: 2, code: "GROUP_VALIDATION_FAILED", message: "no title/brand" }] as any })
      .where(eq(schema.sourceArtifacts.id, up.data.ingestionId));

    const recent = await (await app.request("/ingestions/recent?limit=100")).json() as any;
    const mine = recent.data.ingestions.find((x: any) => x.artifact_id === up.data.ingestionId);
    expect(mine.source_type).toBe("templated_csv");
    expect(mine.error_count).toBe(1);

    const trace = await (await app.request(`/ingestions/${up.data.ingestionId}/trace`)).json() as any;
    expect(trace.data.source_type).toBe("templated_csv");
    expect(trace.data.processing_errors).toHaveLength(1);
  });
});
