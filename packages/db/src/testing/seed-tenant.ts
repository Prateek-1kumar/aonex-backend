// Provides a stable test tenant for schema tests.
// Uses a fixed UUID so tests are idempotent — inserts on first run, reuses on subsequent runs.

import { sql } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";

/** Stable UUID used as the test tenant across all schema tests. */
export const TEST_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Ensures the test tenant row exists in the `tenants` table.
 * Safe to call multiple times (ON CONFLICT DO NOTHING).
 */
export async function ensureTestTenant(db: DrizzleClient): Promise<void> {
  await db.execute(sql`
    INSERT INTO tenants (id, name, status, created_at, updated_at)
    VALUES (
      ${TEST_TENANT_ID}::uuid,
      'Test Tenant (schema tests)',
      'active',
      now(),
      now()
    )
    ON CONFLICT (id) DO NOTHING
  `);
}
