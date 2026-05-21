import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { parseEnv, useNewCatalogSchema } from "./env.js";

/**
 * Build a minimal-valid env object for tests. The EnvSchema has many
 * required fields; this helper supplies plausible defaults so each test
 * can override just the keys it cares about.
 */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/test",
    REDIS_URL: "redis://localhost:6379",
    NANGO_SECRET_KEY: "x",
    NANGO_WEBHOOK_SECRET: "x",
    TOKEN_ENCRYPTION_KEY: "0".repeat(64),
    JWT_SECRET: "x".repeat(32),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("CATALOG_USE_NEW_SCHEMA env flag", () => {
  test("string 'true' parses to boolean true", () => {
    const env = parseEnv(baseEnv({ CATALOG_USE_NEW_SCHEMA: "true" }));
    expect(env.CATALOG_USE_NEW_SCHEMA).toBe(true);
    expect(useNewCatalogSchema(env)).toBe(true);
  });

  test("string 'false' parses to boolean false", () => {
    const env = parseEnv(baseEnv({ CATALOG_USE_NEW_SCHEMA: "false" }));
    expect(env.CATALOG_USE_NEW_SCHEMA).toBe(false);
    expect(useNewCatalogSchema(env)).toBe(false);
  });

  test("missing key defaults to false", () => {
    const env = parseEnv(baseEnv());
    expect(env.CATALOG_USE_NEW_SCHEMA).toBe(false);
    expect(useNewCatalogSchema(env)).toBe(false);
  });

  test("invalid value throws ZodError (no silent coercion)", () => {
    expect(() => parseEnv(baseEnv({ CATALOG_USE_NEW_SCHEMA: "yes" }))).toThrow(ZodError);
    expect(() => parseEnv(baseEnv({ CATALOG_USE_NEW_SCHEMA: "1" }))).toThrow(ZodError);
  });
});
