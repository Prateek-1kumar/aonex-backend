// Integration test — resolveIdentity staging-awareness (Task 3, anomaly-lab plan).
//
// Tests the `includeStaged` flag and the new `candidates` field on
// IdentityResolverResult. Uses a unique TENANT uuid to avoid colliding with
// other concurrent test runs or the shared TEST_TENANT_ID tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  connectTestDb,
  closeTestDb,
  ensureTestTenant,
  ensureTestMerchant,
  TEST_MERCHANT_ID
} from "@aonex/db/testing";
import type { TenantId } from "@aonex/types";
import { resolveIdentity } from "./identity-resolver.js";

// Unique tenant for this test file — never collides with TEST_TENANT_ID or
// other test files.
const STAGING_TENANT_ID = "a0000000-0000-0000-0000-000000000099";
const TENANT = STAGING_TENANT_ID as unknown as TenantId;

const LIVE_GTIN = "11111111111";
const STAGED_GTIN = "22222222222";

describe("resolveIdentity — staging-aware (includeStaged)", () => {
  let db: DrizzleClient;
  let liveCatalogProductId: string;
  let stagedProductId: string;

  beforeAll(async () => {
    db = await connectTestDb();

    // Ensure the tenant row exists (reuse the test tenant infrastructure but
    // insert our unique tenant id directly so we don't affect shared state).
    await db
      .insert(schema.tenants)
      .values({
        id: STAGING_TENANT_ID,
        name: "Staging-Aware IR Test Tenant",
        status: "active"
      })
      .onConflictDoNothing();

    // Ensure the shared test merchant exists (staged_products has no FK, but
    // catalog_products requires a valid merchant_id).
    await ensureTestMerchant(db);

    // Clean up any leftover rows from a previous aborted run.
    await db
      .delete(schema.stagedProducts)
      .where(eq(schema.stagedProducts.tenantId, STAGING_TENANT_ID));
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, STAGING_TENANT_ID));

    // Seed a live catalog_products row (gtin 11111111111, brand "Live").
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: STAGING_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: LIVE_GTIN,
        identity: { gtin: LIVE_GTIN, brand: "Live" },
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    liveCatalogProductId = inserted[0]!.productId;

    // Seed a staged_products pending row (proposed_identity gtin 22222222222,
    // brand "Staged"). staged_products has no FK to tenants/merchants.
    const staged = await db
      .insert(schema.stagedProducts)
      .values({
        tenantId: STAGING_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        proposedIdentity: { gtin: STAGED_GTIN, brand: "Staged" },
        observations: [],
        sourceKind: "test",
        gateVerdict: { verdict: "staged", reasons: [] },
        status: "pending"
      })
      .returning({ stagedProductId: schema.stagedProducts.stagedProductId });
    stagedProductId = staged[0]!.stagedProductId;
  });

  afterAll(async () => {
    await db
      .delete(schema.stagedProducts)
      .where(eq(schema.stagedProducts.tenantId, STAGING_TENANT_ID));
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, STAGING_TENANT_ID));
    await closeTestDb();
  });

  test("1. includeStaged + staged GTIN → candidates has kind='staged' entry with score >= 1", async () => {
    const result = await resolveIdentity({
      db,
      tenantId: TENANT,
      identityHint: { gtin: STAGED_GTIN },
      includeStaged: true
    });

    // No live match — the staged GTIN is not in catalog_products.
    expect(result.productId).toBeNull();
    expect(result.matchPath).toBe("none");

    // candidates must contain the staged entry.
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    const stagedEntry = result.candidates.find(
      (c) => c.kind === "staged" && c.productId === stagedProductId
    );
    expect(stagedEntry).toBeDefined();
    expect(stagedEntry!.score).toBeGreaterThanOrEqual(1);
  });

  test("2. includeStaged + live GTIN → matchPath='gtin', productId not null, candidates has kind='live' entry", async () => {
    const result = await resolveIdentity({
      db,
      tenantId: TENANT,
      identityHint: { gtin: LIVE_GTIN },
      includeStaged: true
    });

    expect(result.matchPath).toBe("gtin");
    expect(result.productId).toBe(liveCatalogProductId);

    // candidates must contain the live entry.
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    const liveEntry = result.candidates.find(
      (c) => c.kind === "live" && c.productId === liveCatalogProductId
    );
    expect(liveEntry).toBeDefined();
  });

  test("3. default (no includeStaged) + staged GTIN → productId null and candidates empty (backward-compat)", async () => {
    const result = await resolveIdentity({
      db,
      tenantId: TENANT,
      identityHint: { gtin: STAGED_GTIN }
      // includeStaged not set — defaults to false
    });

    expect(result.productId).toBeNull();
    expect(result.candidates).toEqual([]);
  });
});
