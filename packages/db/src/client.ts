// Drizzle client — wraps node-postgres Pool.
// `drizzle-orm/node-postgres` chosen per LLD: pg-native excluded
// for Bun TLS edge case (resolution at repo root).
//
// Constructed only in composition roots. Never imported by routes
// or services directly — they take repository ports instead.

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(databaseUrl: string, opts: { max?: number } = {}): {
  client: DrizzleClient;
  pool: Pool;
  close: () => Promise<void>;
} {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 20,
    // Per Appendix B sizing — fail fast under saturation.
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
