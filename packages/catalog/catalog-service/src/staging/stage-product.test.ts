// Integration test — stageProduct (Task 4, anomaly-lab plan).
//
// Verifies that stageProduct inserts a gate-failed AdapterOutput into
// staged_products, denormalising title/brand/price for the lab queue.
// Uses a unique TENANT uuid to avoid colliding with other test files.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  connectTestDb,
  closeTestDb,
  ensureTestMerchant,
  TEST_MERCHANT_ID
} from "@aonex/db/testing";
import type { TenantId, MerchantId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import type { GateVerdict } from "../gate/evaluate-gate.js";
import { stageProduct } from "./stage-product.js";

// Unique tenant for this test file — never collides with TEST_TENANT_ID,
// STAGING_TENANT_ID (a0000000-…-0099) used in identity-resolver.staging.test.ts,
// or any other test file.
const STAGE_PRODUCT_TENANT_ID = "b0000000-0000-0000-0000-000000000099";
const TENANT = STAGE_PRODUCT_TENANT_ID as unknown as TenantId;
const MERCHANT = TEST_MERCHANT_ID as unknown as MerchantId;

describe("stageProduct — insert gate-failed ingest into staged_products", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestMerchant(db);

    // Clean up any leftover rows from a previous aborted run.
    await db
      .delete(schema.stagedProducts)
      .where(eq(schema.stagedProducts.tenantId, STAGE_PRODUCT_TENANT_ID));
  });

  afterAll(async () => {
    await db
      .delete(schema.stagedProducts)
      .where(eq(schema.stagedProducts.tenantId, STAGE_PRODUCT_TENANT_ID));
    await closeTestDb();
  });

  test("inserts a pending staged_products row with correct denorm fields and gateVerdict", async () => {
    // Minimal AdapterOutput: one title observation "Cool Tee", no pricing/inventory,
    // identityHint without brand/gtin.
    const adapterOutput: AdapterOutput = {
      observations: [
        {
          attributeCode: "title",
          target: "parent",
          channelCode: "default",
          localeCode: "en-US",
          source: "test-adapter",
          sourceRecordId: "rec-001",
          value: "Cool Tee",
          confidence: 1.0,
          observedAt: new Date("2026-05-25T00:00:00Z")
        }
      ],
      pricingObservations: [],
      inventoryObservations: [],
      identityHint: {
        // No brand, no gtin — gate will flag both as missing.
        targetIsVariant: false
      },
      rawPayload: null
    };

    const verdict: GateVerdict = {
      admit: false,
      missingFields: ["brand", "identifier"],
      blockingSignals: [],
      infoSignals: []
    };

    const result = await stageProduct({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput,
      sourceKind: "test-adapter",
      channelCode: null,
      verdict,
      matchCandidates: []
    });

    // stageProduct returns the new stagedProductId.
    expect(typeof result.stagedProductId).toBe("string");
    expect(result.stagedProductId.length).toBeGreaterThan(0);

    // SELECT the row back and assert on key fields.
    const rows = await db
      .select()
      .from(schema.stagedProducts)
      .where(eq(schema.stagedProducts.stagedProductId, result.stagedProductId));

    expect(rows.length).toBe(1);
    const row = rows[0]!;

    expect(row.status).toBe("pending");
    expect(row.denormTitle).toBe("Cool Tee");
    expect(row.denormBrand).toBeNull();
    expect(row.denormPrice).toBeNull();

    // gateVerdict.missingFields must contain "brand".
    const gv = row.gateVerdict as { missingFields: string[]; signals: unknown[] };
    expect(Array.isArray(gv.missingFields)).toBe(true);
    expect(gv.missingFields).toContain("brand");
    expect(gv.missingFields).toContain("identifier");
  });
});
