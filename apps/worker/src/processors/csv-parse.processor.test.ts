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
    sourceExternalId: `csv:test:${id}`, parentArtifactId: null,
    rawData: { csv, filename: "test.csv", observedAt: "2026-05-30T00:00:00Z" },
    checksum: createHash("sha256").update(csv).digest("hex"),
    status: "pending",
  });
  return id;
}

describe("runCsvParse", () => {
  let db: DrizzleClient;
  beforeAll(async () => { db = await connectTestDb(); await ensureTestTenant(db); await ensureTestMerchant(db); });
  afterAll(async () => { await closeTestDb(); });

  test("processes valid groups, records bad groups, sets needs_review on partial", async () => {
    const csv = [HEADER,
      "PARSE-OK-1,,,Acme,Good A,Widgets,,USD,19.99,,,,,,,,",
      "PARSE-BAD-1,,,,,,,USD,5.00,,,,,,,,",
    ].join("\n");
    const fileId = await seedFileArtifact(db, csv);

    await runCsvParse({ db, audit: noopAudit, reconcilerQueues: noopReconcilerQueues }, {
      tenantId: TEST_TENANT_ID as any, merchantId: TEST_MERCHANT_ID as any,
      fileArtifactId: fileId, traceId: randomUUID(), requestId: randomUUID(),
    });

    const file = await db.query.sourceArtifacts.findFirst({ where: (a, { eq }) => eq(a.id, fileId) });
    expect(file!.status).toBe("needs_review");
    expect((file!.processingErrors ?? []).filter((e: any) => e.code !== "UNKNOWN_COLUMN")).toHaveLength(1);

    const children = await db.select().from(schema.sourceArtifacts).where(eq(schema.sourceArtifacts.parentArtifactId, fileId));
    expect(children.length).toBe(1);
    expect(children[0]!.sourceExternalId).toBe("PARSE-OK-1");
  });
});
