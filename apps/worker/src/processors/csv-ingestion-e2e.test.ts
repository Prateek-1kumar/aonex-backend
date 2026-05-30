import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  connectTestDb, closeTestDb, ensureTestTenant, ensureTestMerchant,
  TEST_TENANT_ID, TEST_MERCHANT_ID,
} from "@aonex/db/testing";
import { eq } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import { runCsvParse } from "./csv-parse.processor.js";
import type { ReconcilerQueueProvider } from "../services/reconciler-queue-provider.js";
import { reconcilerQueueName } from "@aonex/catalog-service";

const noopReconcilerQueues = {
  forTenant: (tenantId: string) => ({ name: reconcilerQueueName(tenantId), add: async () => ({} as never) } as any),
  close: async () => {},
} as unknown as ReconcilerQueueProvider;

const HEADER = "primary_identifier,gtin,mpn,brand,title,category,description_long,currency,list_price,sale_price,weight_value,weight_unit,variant_color,variant_size,variant_gtin,variant_sku,variant_inventory_qty";
const noopAudit = { emit: async () => {} } as any;

async function seedFileArtifact(db: DrizzleClient, csv: string): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.sourceArtifacts).values({
    id, tenantId: TEST_TENANT_ID, merchantId: TEST_MERCHANT_ID,
    sourceType: "templated_csv", sourceMarketplace: null,
    sourceExternalId: `csv:e2e:${id}`, parentArtifactId: null,
    rawData: { csv, filename: "e2e.csv", observedAt: "2026-05-30T00:00:00Z" },
    checksum: createHash("sha256").update(csv).digest("hex"),
    status: "pending",
  });
  return id;
}

describe("CSV ingestion end-to-end (parse → catalog + report)", () => {
  let db: DrizzleClient;
  beforeAll(async () => { db = await connectTestDb(); await ensureTestTenant(db); await ensureTestMerchant(db); });
  afterAll(async () => { await closeTestDb(); });

  test("a complete product is written to the catalog; a malformed row is reported", async () => {
    // Good row: title+brand+category+currency+price+identifier (gate-passing).
    // Bad row: no title/brand -> GROUP_VALIDATION_FAILED.
    const goodPid = `E2E-GOOD-${randomUUID().slice(0, 8)}`;
    const csv = [HEADER,
      `${goodPid},,,Acme,Real Widget,Widgets,,USD,29.99,,,,,,,,`,
      "E2E-BAD,,,,,,,USD,5.00,,,,,,,,",
    ].join("\n");
    const fileId = await seedFileArtifact(db, csv);

    await runCsvParse({ db, audit: noopAudit, reconcilerQueues: noopReconcilerQueues }, {
      tenantId: TEST_TENANT_ID as any, merchantId: TEST_MERCHANT_ID as any,
      fileArtifactId: fileId, traceId: randomUUID(), requestId: randomUUID(),
    });

    // 1. File report: needs_review (1 processed + 1 hard error), exactly 1 hard error.
    const file = await db.query.sourceArtifacts.findFirst({ where: (a, { eq }) => eq(a.id, fileId) });
    expect(file!.status).toBe("needs_review");
    const hardErrors = (file!.processingErrors ?? []).filter((e: any) => e.code !== "UNKNOWN_COLUMN");
    expect(hardErrors).toHaveLength(1);
    expect(hardErrors[0]!.primaryIdentifier ?? "").toContain("E2E-BAD");

    // 2. The good product's child artifact exists and the catalog write SUCCEEDED
    //    (status flipped to "completed"; a write failure would have set "failed").
    const children = await db.select().from(schema.sourceArtifacts)
      .where(eq(schema.sourceArtifacts.parentArtifactId, fileId));
    expect(children).toHaveLength(1);
    expect(children[0]!.sourceExternalId).toBe(goodPid);
    expect(children[0]!.status).toBe("completed");

    // 3. No child artifact failed (no catalog write errors for valid groups).
    const failedChildren = children.filter((c) => c.status === "failed");
    expect(failedChildren).toHaveLength(0);
  });
});
