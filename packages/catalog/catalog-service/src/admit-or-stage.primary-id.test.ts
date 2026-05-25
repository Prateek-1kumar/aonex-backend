// Integration — admitOrStage with merchant primary_identifier (no gtin/mpn).
// Proves §14: jewelry-like SKU admits, re-upload enriches, distinct SKUs don't merge.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import { closeTestDb, connectTestDb } from "@aonex/db/testing";
import type { ChannelId, MerchantId, TenantId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import { admitOrStage } from "./admit-or-stage.js";

const TENANT_ID = "c0000000-0000-0000-0000-0000000000a1";
const MERCHANT_ID = "c0000000-0000-0000-0000-0000000000a2";
const CHANNEL_ID = "c0000000-0000-0000-0000-0000000000a3";
const CHANNEL_CODE = "csv-in";
const TENANT = TENANT_ID as unknown as TenantId;
const MERCHANT = MERCHANT_ID as unknown as MerchantId;
const CHANNEL = CHANNEL_ID as unknown as ChannelId;
const TEST_ACTOR = "test:aos-primary-id";

function jewelryOutput(primaryId: string, title: string, suffix: string): AdapterOutput {
  return {
    observations: [
      { attributeCode: "title", target: "parent", channelCode: CHANNEL_CODE, localeCode: "en_IN",
        source: "spreadsheet:stock.xlsx", sourceRecordId: `csv:${suffix}`, value: title, confidence: 0.9,
        observedAt: new Date("2026-05-25T10:00:00Z") },
      { attributeCode: "category_path", target: "parent", channelCode: CHANNEL_CODE, localeCode: "en_IN",
        source: "spreadsheet:stock.xlsx", sourceRecordId: `csv:${suffix}-cat`, value: "Jewelry > Rings",
        confidence: 0.9, observedAt: new Date("2026-05-25T10:00:00Z") }
    ],
    pricingObservations: [
      { productHint: primaryId, channelCode: CHANNEL_CODE, locale: "en_IN", source: "spreadsheet:stock.xlsx",
        sourceRecordId: `csv:${suffix}-price`, currency: "INR", tiers: [{ kind: "list", amount: 57515.92 }],
        observedAt: new Date("2026-05-25T10:00:00Z") }
    ],
    inventoryObservations: [],
    identityHint: { brand: "MyJeweler", primary_identifier: primaryId, titleForFuzzy: title, targetIsVariant: false },
    rawPayload: { src: "aos-primary-id-test" }
  };
}

async function cleanup(db: DrizzleClient): Promise<void> {
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT_ID));
  await db.delete(schema.catalogPricingObservations).where(eq(schema.catalogPricingObservations.tenantId, TENANT_ID));
  await db.execute(sql`DELETE FROM catalog_events WHERE tenant_id = ${TENANT_ID}`);
  await db.execute(sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`);
  await db.delete(schema.catalogProductRevisions).where(eq(schema.catalogProductRevisions.tenantId, TENANT_ID));
  await db.execute(sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`);
  await db.delete(schema.identityLog).where(eq(schema.identityLog.tenantId, TENANT_ID));
  await db.delete(schema.reviewTasks).where(eq(schema.reviewTasks.tenantId, TENANT_ID));
  await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TENANT_ID));
  await db.delete(schema.channels).where(eq(schema.channels.channelId, CHANNEL_ID));
  await db.delete(schema.sourcePriority).where(eq(schema.sourcePriority.actor, TEST_ACTOR));
  await db.delete(schema.merchants).where(eq(schema.merchants.id, MERCHANT_ID));
  await db.delete(schema.tenants).where(eq(schema.tenants.id, TENANT_ID));
}

async function seed(db: DrizzleClient): Promise<void> {
  await db.insert(schema.tenants).values({ id: TENANT_ID, name: "AOS PrimaryID Tenant", status: "active" }).onConflictDoNothing();
  await db.insert(schema.merchants).values({
    id: MERCHANT_ID, tenantId: TENANT_ID, email: "aos-primary-id@tests.internal",
    passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only", displayName: "AOS PrimaryID Merchant",
    defaultCurrency: "INR"
  }).onConflictDoNothing();
  await db.insert(schema.channels).values({
    channelId: CHANNEL_ID, tenantId: TENANT_ID, channelKind: "csv", region: "in",
    accountRef: "aos-primary-id-tests", defaultCurrency: "INR", defaultLocale: "en_IN", displayName: "CSV In"
  }).onConflictDoNothing();
  await db.insert(schema.sourcePriority).values({
    tenantId: null, attributeCode: null, sourceGlob: "*", channelScope: null, priority: 100,
    rulesVersion: 1, actor: TEST_ACTOR
  });
}

describe("admitOrStage — merchant primary_identifier", () => {
  let db: DrizzleClient;
  beforeAll(async () => { db = await connectTestDb(); await cleanup(db); await seed(db); });
  afterAll(async () => { await cleanup(db); await closeTestDb(); });

  test("jewelry SKU (no gtin/mpn) → admitted, keyed on primary_identifier", async () => {
    const r = await admitOrStage({
      db, tenantId: TENANT, merchantId: MERCHANT,
      adapterOutput: jewelryOutput("m1:RG19", "14K Gold Diamond Ring RG19", "RG19"),
      sourceKind: "spreadsheet", actor: TEST_ACTOR, channelCode: CHANNEL_CODE,
      channelCodeToId: { [CHANNEL_CODE]: CHANNEL }
    });
    expect(r.outcome).toBe("admitted");
    expect(r.productId).not.toBeNull();
    const rows = await db.select().from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.primaryIdentifier, "m1:RG19"));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.identity as Record<string, unknown>)["primary_identifier"]).toBe("m1:RG19");
  });

  test("re-upload of the same SKU → enriched (same product, no duplicate)", async () => {
    const r = await admitOrStage({
      db, tenantId: TENANT, merchantId: MERCHANT,
      adapterOutput: jewelryOutput("m1:RG19", "14K Gold Diamond Ring RG19", "RG19-again"),
      sourceKind: "spreadsheet", actor: TEST_ACTOR, channelCode: CHANNEL_CODE,
      channelCodeToId: { [CHANNEL_CODE]: CHANNEL }
    });
    expect(r.outcome).toBe("enriched");
    const rows = await db.select().from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.primaryIdentifier, "m1:RG19"));
    expect(rows).toHaveLength(1);
  });

  test("distinct same-brand SKU → admitted as a SEPARATE product (no fuzzy merge)", async () => {
    const r = await admitOrStage({
      db, tenantId: TENANT, merchantId: MERCHANT,
      adapterOutput: jewelryOutput("m1:RG21", "14K Gold Diamond Ring RG21", "RG21"),
      sourceKind: "spreadsheet", actor: TEST_ACTOR, channelCode: CHANNEL_CODE,
      channelCodeToId: { [CHANNEL_CODE]: CHANNEL }
    });
    expect(r.outcome).toBe("admitted");
    const rg21 = await db.select().from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.primaryIdentifier, "m1:RG21"));
    const rg19 = await db.select().from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.primaryIdentifier, "m1:RG19"));
    expect(rg21).toHaveLength(1);
    expect(rg19).toHaveLength(1);
    expect(rg21[0]!.productId).not.toBe(rg19[0]!.productId);
  });
});
