// Provides a stable test tenant for schema tests.
// Uses a fixed UUID so tests are idempotent — inserts on first run, reuses on subsequent runs.

import { tenants } from "../schema/tenants.js";
import type { DrizzleClient } from "../client.js";

/** Stable UUID used as the test tenant across all schema tests. */
export const TEST_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Ensures the test tenant row exists in the `tenants` table.
 * Safe to call multiple times (onConflictDoNothing).
 */
export async function ensureTestTenant(db: DrizzleClient): Promise<void> {
  await db.insert(tenants)
    .values({
      id: TEST_TENANT_ID,
      name: "Test Tenant (schema tests)",
      status: "active"
    })
    .onConflictDoNothing();
}
