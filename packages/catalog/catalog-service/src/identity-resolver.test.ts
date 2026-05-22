// Tests for the identity resolver (spec §18). Runs against the real dev DB
// using the shared @aonex/db testing helpers. Each test seeds a row in
// catalog_products (scoped to TEST_TENANT_ID), invokes resolveIdentity, and
// asserts the returned IdentityResolverResult.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  connectTestDb,
  closeTestDb,
  ensureTestTenant,
  TEST_TENANT_ID,
  ensureTestMerchant,
  TEST_MERCHANT_ID
} from "@aonex/db/testing";
import type { TenantId } from "@aonex/types";
import { resolveIdentity } from "./identity-resolver.js";

const TENANT = TEST_TENANT_ID as unknown as TenantId;

describe("resolveIdentity (spec §18)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    // Clear any leftover rows from previous runs (scoped to test tenant only).
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    await closeTestDb();
  });

  test("1. GTIN exact match returns strength 1.0 + matchPath gtin", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "IR-GTIN-001",
        identity: { gtin: "8806095269757", brand: "Samsung" },
        status: "active",
        values: {}
      })
      .returning();
    const seeded = inserted[0]!;

    const result = await resolveIdentity({
      db,
      tenantId: TENANT,
      identityHint: { gtin: "8806095269757" }
    });

    expect(result.matchPath).toBe("gtin");
    expect(result.productId).toBe(seeded.productId);
    expect(result.strength).toBe(1.0);
    expect(result.reviewTaskSuggested).toBe(false);
    expect(result.candidateProductIds).toEqual([seeded.productId]);
  });

  test("2. MPN + brand exact match returns strength 0.9 + matchPath mpn_brand", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "IR-MPN-001",
        identity: { mpn: "DV3853-001", brand: "Nike" },
        status: "active",
        values: {}
      })
      .returning();
    const seeded = inserted[0]!;

    const result = await resolveIdentity({
      db,
      tenantId: TENANT,
      identityHint: { mpn: "DV3853-001", brand: "Nike" }
    });

    expect(result.matchPath).toBe("mpn_brand");
    expect(result.productId).toBe(seeded.productId);
    expect(result.strength).toBe(0.9);
    expect(result.reviewTaskSuggested).toBe(false);
  });

  test("3. Fuzzy high match (>= 0.7) returns productId + matchPath fuzzy_high", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "IR-FUZZY-HIGH-001",
        identity: { brand: "Nike" },
        family: "shoe",
        status: "active",
        values: {},
        winningValues: {
          title: { _primary: { value: "Nike Pegasus 40 Running Shoes" } }
        }
      })
      .returning();
    const seeded = inserted[0]!;

    const result = await resolveIdentity({
      db,
      tenantId: TENANT,
      identityHint: {
        brand: "Nike",
        titleForFuzzy: "Nike Pegasus 40 Mens Road Running"
      },
      inferredFamily: "shoe"
    });

    expect(result.matchPath).toBe("fuzzy_high");
    expect(result.productId).toBe(seeded.productId);
    expect(result.strength).toBeGreaterThanOrEqual(0.7);
    expect(result.reviewTaskSuggested).toBe(false);
    expect(result.candidateProductIds).toContain(seeded.productId);
  });

  test("4. Fuzzy review band (0.5–0.7) returns null + reviewTaskSuggested", async () => {
    // Seed a single weak candidate. Brand exact match contributes 1.0 × 0.15;
    // title-similarity is deliberately low so the composite lands in the
    // 0.5–0.7 review band (signalCoverage = 0.40 — only brand+title signals).
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "IR-FUZZY-REVIEW-001",
        identity: { brand: "Acme" },
        family: "widget",
        status: "active",
        values: {},
        winningValues: {
          title: { _primary: { value: "Acme Original Widget Box" } }
        }
      })
      .returning();
    const seeded = inserted[0]!;

    const result = await resolveIdentity({
      db,
      tenantId: TENANT,
      identityHint: {
        brand: "Acme",
        // Deliberately low J-W similarity to keep composite ~0.65.
        titleForFuzzy: "qqq vvv jjj kkk"
      },
      inferredFamily: "widget"
    });

    expect(result.matchPath).toBe("fuzzy_review");
    expect(result.productId).toBeNull();
    expect(result.strength).toBe(0);
    expect(result.reviewTaskSuggested).toBe(true);
    expect(result.candidateProductIds).toContain(seeded.productId);
  });

  test("5. No match returns null + matchPath none", async () => {
    const result = await resolveIdentity({
      db,
      tenantId: TENANT,
      identityHint: {
        brand: "BrandThatDefinitelyDoesNotExistInThisTenant",
        titleForFuzzy: "Random product nobody seeded"
      }
    });

    expect(result.matchPath).toBe("none");
    expect(result.productId).toBeNull();
    expect(result.strength).toBe(0);
    expect(result.reviewTaskSuggested).toBe(false);
    expect(result.candidateProductIds).toEqual([]);
  });
});
