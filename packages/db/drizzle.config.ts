// drizzle-kit configuration (migration generation + studio).
//
// Points drizzle-kit at the schema barrel and ./drizzle output, targeting
// postgresql via DATABASE_URL. bundle:true lets its CJS loader resolve the
// ESM .js → .ts schema imports. Consumed by the db:migrate / db:studio scripts.

import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev"
  },
  strict: true,
  verbose: true,
  // drizzle-kit loads schema via CJS require; bundle:true resolves ESM .js → .ts
  bundle: true
} satisfies Config;
