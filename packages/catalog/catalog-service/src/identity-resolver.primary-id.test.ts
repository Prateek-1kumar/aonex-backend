// Integration test — resolveIdentity primary_identifier (merchant SKU) path.
// Unique tenant to avoid colliding with other resolver test files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import { connectTestDb, closeTestDb, ensureTestMerchant, TEST_MERCHANT_ID } from "@aonex/db/testing";
import type { TenantId } from "@aonex/types";
import { resolveIdentity } from "./identity-resolver.js";

const TENANT_ID = "a0000000-0000-0000-0000-0000000000aa";
const TENANT = TENANT_ID as unknown as TenantId;

describe("resolveIdentity — primary_identifier (merchant SKU)", () => {
  let db: DrizzleClient;
  let rg19Id: string;

  beforeAll(async () => {
    db = await connectTestDb();
    await db.insert(schema.tenants)
      .values({ id: TENANT_ID, name: "Primary-ID Test Tenant", status: "active" })
      .onConflictDoNothing();
    await ensureTestMerchant(db);
    await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TENANT_ID));

    // Two distinct pieces, SAME brand, near-identical titles — the fuzzy-merge trap.
    const rg19 = await db.insert(schema.catalogProducts).values({
      tenantId: TENANT_ID, merchantId: TEST_MERCHANT_ID,
      primaryIdentifier: "m1:RG19",
      identity: { brand: "MyJeweler", primary_identifier: "m1:RG19" },
      status: "active", values: {}
    }).returning({ productId: schema.catalogProducts.productId });
    rg19Id = rg19[0]!.productId;

    await db.insert(schema.catalogProducts).values({
      tenantId: TENANT_ID, merchantId: TEST_MERCHANT_ID,
      primaryIdentifier: "m1:RG21",
      identity: { brand: "MyJeweler", primary_identifier: "m1:RG21" },
      status: "active", values: {}
    });
  });

  afterAll(async () => {
    await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TENANT_ID));
    await closeTestDb();
  });

  test("exact match → matchPath 'primary_id', correct product, live candidate", async () => {
    const r = await resolveIdentity({ db, tenantId: TENANT, identityHint: { primary_identifier: "m1:RG19" } });
    expect(r.matchPath).toBe("primary_id");
    expect(r.productId).toBe(rg19Id);
    expect(r.strength).toBe(1.0);
    expect(r.candidates[0]).toMatchObject({ productId: rg19Id, kind: "live", score: 1.0 });
  });

  test("present but no exact match → 'none', and does NOT fuzzy-merge a same-brand sibling", async () => {
    const r = await resolveIdentity({
      db, tenantId: TENANT,
      identityHint: { primary_identifier: "m1:RG99", brand: "MyJeweler", titleForFuzzy: "14K Gold Diamond Ring" }
    });
    expect(r.matchPath).toBe("none");
    expect(r.productId).toBeNull();
  });
});
