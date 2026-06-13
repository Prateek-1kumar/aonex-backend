// Test DB helper: a shared Drizzle client connected to DATABASE_URL, reused
// across tests in one run to avoid connection churn.

import { createDb } from "../client.js";
import type { DrizzleClient } from "../client.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

let _instance: { client: DrizzleClient; close: () => Promise<void> } | null = null;

/**
 * Returns a shared Drizzle client for the test process.
 * Reuses the same pool across tests in one run to avoid connection churn.
 */
export async function connectTestDb(): Promise<DrizzleClient> {
  if (!_instance) {
    const { client, close } = createDb(DATABASE_URL, { max: 5 });
    _instance = { client, close };
  }
  return _instance.client;
}

/**
 * Call in afterAll if you want to cleanly close the pool.
 */
export async function closeTestDb(): Promise<void> {
  if (_instance) {
    await _instance.close();
    _instance = null;
  }
}
