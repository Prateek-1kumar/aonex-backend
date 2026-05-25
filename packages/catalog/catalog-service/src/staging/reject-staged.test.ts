// Integration tests for rejectStagedProduct (Anomaly Lab Task 9, Part A).
//
// Uses the real DB. Unique tenant UUID to avoid collision with all other
// test files.
//
// Cases:
//   1. Happy path: stage a product, reject it → status='rejected', resolvedBy
//      set, NO catalog_products row created.
//   2. Already-rejected path: reject again → throws (not pending).
//   3. Non-existent row → throws.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
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
import { stageProduct } from "./stage-product.js";
import { evaluateGate } from "../gate/evaluate-gate.js";
import { rejectStagedProduct } from "./reject-staged.js";

// ---- Unique IDs for this test suite ----------------------------------------
// Never collide with:
//   TEST_TENANT_ID         "00000000-…-0001"  (catalog-write.test.ts)
//   STAGE_PRODUCT_TENANT   "b0000000-…-0099"  (stage-product.test.ts)
//   TENANT_ID              "c0000000-…-0099"  (admit-or-stage.test.ts)
//   FORCE_ID_TEST_TENANT   "ffffffff-…-0099"  (catalog-write.force-id.test.ts)
//   PROMOTE_TENANT_ID      "d0000000-…-0099"  (promote-staged.test.ts)
//   LINK_TENANT_ID         "e0000000-…-0099"  (link-staged.test.ts)

const REJECT_TENANT_ID = "f0000000-0000-0000-0000-000000000099";
const REJECT_MERCHANT_ID = TEST_MERCHANT_ID;

const TENANT = REJECT_TENANT_ID as unknown as TenantId;
const MERCHANT = REJECT_MERCHANT_ID as unknown as MerchantId;

const TEST_ACTOR = "test:reject-staged";
const RESOLVER_ID = "f0000000-0000-0000-0000-000000000097";

// ---- Helpers ---------------------------------------------------------------

async function seedRules(db: DrizzleClient): Promise<void> {
  await db.insert(schema.sourcePriority).values({
    tenantId: null,
    attributeCode: null,
    sourceGlob: "*",
    channelScope: null,
    priority: 100,
    rulesVersion: 1,
    actor: TEST_ACTOR
  });
}

/**
 * An AdapterOutput that is missing brand + identifier → gate always fails.
 * rejectStagedProduct only touches staged_products — no channel/catalog
 * seeding needed.
 */
function incompleteAdapterOutput(): AdapterOutput {
  return {
    observations: [
      {
        attributeCode: "title",
        target: "parent",
        channelCode: "shopify-au",
        localeCode: "en-AU",
        source: "shopify:connector",
        sourceRecordId: "rec-reject-001",
        value: "Widget Cap",
        confidence: 0.95,
        observedAt: new Date("2026-05-25T10:00:00Z")
      }
    ],
    pricingObservations: [],
    inventoryObservations: [],
    identityHint: {
      // No brand, no gtin/mpn → gate fails
      targetIsVariant: false
    },
    rawPayload: { src: "reject-staged-test" }
  };
}

async function stageIncompleteProduct(db: DrizzleClient): Promise<string> {
  const out = incompleteAdapterOutput();
  const verdict = evaluateGate({ adapterOutput: out, signals: [] });
  if (verdict.admit) {
    throw new Error("test setup error: incompleteAdapterOutput should NOT pass the gate");
  }
  const result = await stageProduct({
    db,
    tenantId: TENANT,
    merchantId: MERCHANT,
    adapterOutput: out,
    sourceKind: "shopify",
    channelCode: "shopify-au",
    verdict,
    matchCandidates: []
  });
  return result.stagedProductId;
}

async function cleanup(db: DrizzleClient): Promise<void> {
  // Staged products
  await db
    .delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.tenantId, REJECT_TENANT_ID));

  // Source priority rules
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));

  // Merchant seeded for this tenant
  await db
    .delete(schema.merchants)
    .where(eq(schema.merchants.id, RESOLVER_ID));

  // Tenant
  await db
    .delete(schema.tenants)
    .where(eq(schema.tenants.id, REJECT_TENANT_ID));
}

// ---- Suite setup -----------------------------------------------------------

describe("rejectStagedProduct (Task 9 Part A)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();

    // Seed tenant
    await db
      .insert(schema.tenants)
      .values({
        id: REJECT_TENANT_ID,
        name: "Test Tenant (reject-staged)",
        status: "active"
      })
      .onConflictDoNothing();

    // Ensure shared merchant exists
    await ensureTestMerchant(db);

    // Seed a dedicated merchant for the resolvedBy FK if needed
    // (resolvedBy is uuid in staged_products but no FK constraint — it's a
    // reviewer user id. Use a known test id for determinism.)
    await db
      .insert(schema.merchants)
      .values({
        id: RESOLVER_ID,
        tenantId: REJECT_TENANT_ID,
        email: "test-reject-staged@reject-staged-tests.internal",
        passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only",
        displayName: "Test Merchant (reject-staged)",
        defaultCurrency: "AUD"
      })
      .onConflictDoNothing();

    await cleanup(db);

    // Re-seed after cleanup wipes them
    await db
      .insert(schema.tenants)
      .values({
        id: REJECT_TENANT_ID,
        name: "Test Tenant (reject-staged)",
        status: "active"
      })
      .onConflictDoNothing();
    await db
      .insert(schema.merchants)
      .values({
        id: RESOLVER_ID,
        tenantId: REJECT_TENANT_ID,
        email: "test-reject-staged@reject-staged-tests.internal",
        passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only",
        displayName: "Test Merchant (reject-staged)",
        defaultCurrency: "AUD"
      })
      .onConflictDoNothing();

    await seedRules(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  // ---- Happy path -----------------------------------------------------------
  test("1. rejects a pending staged product: status=rejected, resolvedBy set, no catalog row", async () => {
    const stagedProductId = await stageIncompleteProduct(db);

    // Verify catalog_products count is zero before (reject never creates one)
    const beforeCount = Number(
      (
        await db
          .select({ count: sql<string>`count(*)::text` })
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.tenantId, REJECT_TENANT_ID))
      )[0]!.count
    );

    await rejectStagedProduct({
      db,
      tenantId: TENANT,
      stagedProductId,
      resolvedBy: RESOLVER_ID
    });

    // ---- staged row: status='rejected', resolvedBy set ---------------------
    const stagedRows = await db
      .select()
      .from(schema.stagedProducts)
      .where(eq(schema.stagedProducts.stagedProductId, stagedProductId));
    expect(stagedRows.length).toBe(1);
    const staged = stagedRows[0]!;
    expect(staged.status).toBe("rejected");
    expect(staged.resolvedBy).toBe(RESOLVER_ID);
    expect(staged.resolvedAt).not.toBeNull();

    // ---- NO catalog_products row created ------------------------------------
    const afterCount = Number(
      (
        await db
          .select({ count: sql<string>`count(*)::text` })
          .from(schema.catalogProducts)
          .where(eq(schema.catalogProducts.tenantId, REJECT_TENANT_ID))
      )[0]!.count
    );
    expect(afterCount).toBe(beforeCount);
    expect(afterCount).toBe(0);
  });

  // ---- Idempotency / already-terminal path ---------------------------------
  test("2. rejecting an already-rejected staged product throws", async () => {
    const stagedProductId = await stageIncompleteProduct(db);

    // First reject succeeds
    await rejectStagedProduct({
      db,
      tenantId: TENANT,
      stagedProductId,
      resolvedBy: RESOLVER_ID
    });

    // Second reject must throw because status is no longer 'pending'
    let thrown: unknown;
    try {
      await rejectStagedProduct({
        db,
        tenantId: TENANT,
        stagedProductId,
        resolvedBy: RESOLVER_ID
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("not pending");
  });

  // ---- Non-existent row ---------------------------------------------------
  test("3. rejecting a non-existent stagedProductId throws", async () => {
    const fakeId = "aaaaaaaa-0000-0000-0000-000000000000";
    let thrown: unknown;
    try {
      await rejectStagedProduct({
        db,
        tenantId: TENANT,
        stagedProductId: fakeId,
        resolvedBy: RESOLVER_ID
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("not pending");
  });
});
