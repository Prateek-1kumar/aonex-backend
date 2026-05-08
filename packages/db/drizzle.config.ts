import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev"
  },
  strict: true,
  verbose: true
} satisfies Config;
