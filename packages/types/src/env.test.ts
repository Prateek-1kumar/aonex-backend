import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { parseEnv } from "./env.js";

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

describe("parseEnv", () => {
  test("parses valid env", () => {
    const env = parseEnv(baseEnv());
    expect(env.NODE_ENV).toBe("test");
  });

  test("throws ZodError on invalid NODE_ENV", () => {
    expect(() => parseEnv(baseEnv({ NODE_ENV: "bad" }))).toThrow(ZodError);
  });

  test("defaults LOG_LEVEL to info", () => {
    const env = parseEnv(baseEnv());
    expect(env.LOG_LEVEL).toBe("info");
  });
});
