// Provides a stable test merchant for schema tests.
// Uses a fixed UUID so tests are idempotent — inserts on first run, reuses on subsequent runs.
// The test merchant is always associated with the test tenant (TEST_TENANT_ID).

import { merchants } from "../schema/merchants.js";
import type { DrizzleClient } from "../client.js";
import { TEST_TENANT_ID } from "./seed-tenant.js";

/** Stable UUID used as the test merchant across all schema tests. */
export const TEST_MERCHANT_ID = "00000000-0000-0000-0000-000000000002";

/**
 * Ensures the test merchant row exists in the `merchants` table.
 * Safe to call multiple times (onConflictDoNothing).
 */
export async function ensureTestMerchant(db: DrizzleClient): Promise<void> {
  await db
    .insert(merchants)
    .values({
      id: TEST_MERCHANT_ID,
      tenantId: TEST_TENANT_ID,
      email: "test-merchant@schema-tests.internal",
      passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only",
      displayName: "Test Merchant (schema tests)",
      defaultCurrency: "USD"
    })
    .onConflictDoNothing();
}
