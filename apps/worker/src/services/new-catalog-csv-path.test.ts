import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectTestDb, closeTestDb, ensureTestTenant, ensureTestMerchant,
  ensureTestChannel, TEST_CHANNEL_ID,
  TEST_TENANT_ID, TEST_MERCHANT_ID,
} from "@aonex/db/testing";
import { adaptGroups } from "@aonex/catalog-source-adapters";
import type { CsvAdapterInput } from "@aonex/catalog-source-adapters";
import { resolveOrCreateCsvChannel, runNewCsvCatalogPath } from "./new-catalog-csv-path.js";
import { reconcilerQueueName, reconcilerJobId } from "@aonex/catalog-service";
import type { Queue } from "bullmq";
import { randomUUID } from "node:crypto";

const HEADER = "primary_identifier,gtin,mpn,brand,title,category,description_long,currency,list_price,sale_price,weight_value,weight_unit,variant_color,variant_size,variant_gtin,variant_sku,variant_inventory_qty";

describe("runNewCsvCatalogPath", () => {
  let db: Awaited<ReturnType<typeof connectTestDb>>;
  beforeAll(async () => { db = await connectTestDb(); await ensureTestTenant(db); await ensureTestMerchant(db); await ensureTestChannel(db); });
  afterAll(async () => { await closeTestDb(); });

  test("resolveOrCreateCsvChannel is idempotent and returns a channelId", async () => {
    const a = await resolveOrCreateCsvChannel(db, TEST_TENANT_ID as any);
    const b = await resolveOrCreateCsvChannel(db, TEST_TENANT_ID as any);
    expect(a.channelId).toBe(b.channelId);
  });

  test("runNewCsvCatalogPath enqueues pricing reconcile when given a queue", async () => {
    const added: Array<{ opts: any }> = [];
    const stubQueue = {
      name: reconcilerQueueName(TEST_TENANT_ID),
      add: async (_n: string, _d: unknown, opts: unknown) => { added.push({ opts }); return {} as never; },
    } as unknown as Queue;

    const pid = `CSV-t5-${randomUUID()}`;
    const observedAt = new Date("2026-05-30T03:00:00Z");
    const res = await runNewCsvCatalogPath({
      db,
      tenantId: TEST_TENANT_ID as any,
      merchantId: TEST_MERCHANT_ID as any,
      artifactId: randomUUID() as never,
      channel: { channelId: TEST_CHANNEL_ID as any },
      reconcilerQueue: stubQueue,
      adapterOutput: {
        observations: [
          { attributeCode: "title", target: "parent", channelCode: "csv", localeCode: "_unscoped", source: "csv:f.csv", sourceRecordId: pid, value: "Kettle Deluxe", confidence: 0.85, observedAt },
          { attributeCode: "brand", target: "parent", channelCode: "_unscoped", localeCode: "_unscoped", source: "csv:f.csv", sourceRecordId: pid, value: "Kettle & Co", confidence: 0.9, observedAt },
          { attributeCode: "category_path", target: "parent", channelCode: "csv", localeCode: "_unscoped", source: "csv:f.csv", sourceRecordId: pid, value: "Toys > Building Sets", confidence: 0.85, observedAt },
        ],
        pricingObservations: [
          { productHint: pid, channelCode: "csv", locale: "_unscoped", source: "csv:f.csv", sourceRecordId: pid, currency: "USD", tiers: [{ kind: "list", amount: 69.68 }], observedAt },
        ],
        inventoryObservations: [],
        identityHint: { primary_identifier: pid, brand: "Kettle & Co", titleForFuzzy: "Kettle Deluxe", targetIsVariant: false },
        rawPayload: { primary_identifier: pid },
      },
    });

    expect(res.outcome).toBe("admitted");
    expect(added.length).toBe(1);
    expect(added[0]!.opts.jobId).toBe(reconcilerJobId(res.productId!, "pricing"));
  });

  test("admits a valid product group to the catalog", async () => {
    // Gate (CANONICAL_MINIMUM) needs title + brand + primary pricing +
    // category_path + a hard identifier. primary_identifier counts as the
    // identifier for CSV, so this row is gate-complete and should admit.
    const csv = [HEADER, "CSV-PATH-1,,,Acme,Widget A,Widgets,,USD,19.99,,,,,,,,"].join("\n");
    const input: CsvAdapterInput = { csv, filename: "t.csv", observedAt: "2026-05-30T00:00:00Z" };
    const { groups } = adaptGroups(input, {
      tenantId: TEST_TENANT_ID as any, channelId: "x" as any,
      channelDefaultCurrency: null, channelDefaultLocale: null,
      attributeDefinitions: [], attributeSynonyms: [],
    });
    const res = await runNewCsvCatalogPath({
      db, tenantId: TEST_TENANT_ID as any, merchantId: TEST_MERCHANT_ID as any,
      artifactId: "00000000-0000-0000-0000-0000000a0001" as any,
      adapterOutput: groups[0]!.output,
    });
    expect(["admitted", "enriched"]).toContain(res.outcome);
    expect(res.productId).not.toBeNull();
  });
});
