// Integration test for resolveIdentity staging-awareness: the `includeStaged`
// flag and the `candidates` field on IdentityResolverResult. Uses a unique
// tenant uuid to avoid colliding with other test runs or the shared TEST_TENANT_ID.

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
import type { TenantId } from "@aonex/types";
import { resolveIdentity } from "./identity-resolver.js";

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

    await db
      .insert(schema.tenants)
      .values({
        id: STAGING_TENANT_ID,
        name: "Staging-Aware IR Test Tenant",
        status: "active"
      })
      .onConflictDoNothing();

    await ensureTestMerchant(db);

    await db
      .delete(schema.stagedProducts)
      .where(eq(schema.stagedProducts.tenantId, STAGING_TENANT_ID));
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, STAGING_TENANT_ID));

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

    expect(result.productId).toBeNull();
    expect(result.matchPath).toBe("none");

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    const stagedEntry = result.candidates.find(
      (c) => c.kind === "staged" && c.productId === stagedProductId
    );
    expect(stagedEntry).toBeDefined();
    expect(stagedEntry!.score).toBe(1.0);
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
    });

    expect(result.productId).toBeNull();
    expect(result.candidates).toEqual([]);
  });
});
