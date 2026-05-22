// Provides a stable test channel for schema tests.
// Uses a fixed UUID so tests are idempotent — inserts on first run, reuses on subsequent runs.
// The test channel is always associated with the test tenant (TEST_TENANT_ID).

import { channels } from "../schema/channels.js";
import type { DrizzleClient } from "../client.js";
import { TEST_TENANT_ID } from "./seed-tenant.js";

/** Stable UUID used as the test channel across all schema tests. */
export const TEST_CHANNEL_ID = "00000000-0000-0000-0000-000000000003";

/**
 * Ensures the test channel row exists in the `channels` table.
 * Safe to call multiple times (onConflictDoNothing).
 */
export async function ensureTestChannel(db: DrizzleClient): Promise<void> {
  await db
    .insert(channels)
    .values({
      channelId: TEST_CHANNEL_ID,
      tenantId: TEST_TENANT_ID,
      channelKind: "shopify",
      region: "au",
      accountRef: "schema-tests",
      defaultCurrency: "AUD",
      defaultLocale: "en_AU",
      displayName: "Test Channel (schema tests)"
    })
    .onConflictDoNothing();
}
