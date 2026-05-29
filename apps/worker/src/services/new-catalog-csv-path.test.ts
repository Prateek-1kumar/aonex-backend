import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@aonex/db";
import {
  connectTestDb, closeTestDb, ensureTestTenant, ensureTestMerchant,
  TEST_TENANT_ID, TEST_MERCHANT_ID,
} from "@aonex/db/testing";
import { adaptGroups } from "@aonex/catalog-source-adapters";
import type { CsvAdapterInput } from "@aonex/catalog-source-adapters";
import { resolveOrCreateCsvChannel, runNewCsvCatalogPath } from "./new-catalog-csv-path.js";

const HEADER = "primary_identifier,gtin,mpn,brand,title,category,description_long,currency,list_price,sale_price,weight_value,weight_unit,variant_color,variant_size,variant_gtin,variant_sku,variant_inventory_qty";

describe("runNewCsvCatalogPath", () => {
  let db: Awaited<ReturnType<typeof connectTestDb>>;
  beforeAll(async () => { db = await connectTestDb(); await ensureTestTenant(db); await ensureTestMerchant(db); });
  afterAll(async () => { await closeTestDb(db); });

  test("resolveOrCreateCsvChannel is idempotent and returns a channelId", async () => {
    const a = await resolveOrCreateCsvChannel(db, TEST_TENANT_ID as any);
    const b = await resolveOrCreateCsvChannel(db, TEST_TENANT_ID as any);
    expect(a.channelId).toBe(b.channelId);
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
