// Drizzle client wrapping a node-postgres Pool.
// Constructed only in composition roots; routes/services take repository ports instead.
// Uses node-postgres (not pg-native) to avoid a Bun TLS edge case.

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

/** A query executor — either the client or a transaction handle. Lets shared
 *  write-helpers compose into a caller's transaction without importing
 *  drizzle-orm outside this package. */
export type DrizzleExecutor = DrizzleClient | Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

export function createDb(databaseUrl: string, opts: { max?: number } = {}): {
  client: DrizzleClient;
  pool: Pool;
  close: () => Promise<void>;
} {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 20,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    application_name: "aonex"
  });
  const client = drizzle(pool, { schema });
  return {
    client,
    pool,
    close: async () => {
      await pool.end();
    }
  };
}

export { schema };
export type { Pool };
