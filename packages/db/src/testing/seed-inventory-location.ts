// Provides a stable test inventory location for schema tests.
// Uses a fixed UUID so tests are idempotent — inserts on first run, reuses on subsequent runs.
// The test location is always attached to the test channel (TEST_CHANNEL_ID).

import { inventoryLocations } from "../schema/channels.js";
import type { DrizzleClient } from "../client.js";
import { TEST_TENANT_ID } from "./seed-tenant.js";
import { TEST_CHANNEL_ID } from "./seed-channel.js";

/** Stable UUID used as the test inventory location across all schema tests. */
export const TEST_LOCATION_ID = "00000000-0000-0000-0000-000000000004";

/**
 * Ensures the test inventory location row exists in the `inventory_locations` table.
 * Safe to call multiple times (onConflictDoNothing).
 */
export async function ensureTestInventoryLocation(db: DrizzleClient): Promise<void> {
  await db
    .insert(inventoryLocations)
    .values({
      locationId: TEST_LOCATION_ID,
      channelId: TEST_CHANNEL_ID,
      tenantId: TEST_TENANT_ID,
      kind: "warehouse",
      externalRef: "schema-tests",
      displayName: "Test Inventory Location (schema tests)"
    })
    .onConflictDoNothing();
}
