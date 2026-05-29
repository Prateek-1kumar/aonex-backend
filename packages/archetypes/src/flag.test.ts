import { test, expect } from "bun:test";
import { archetypeEnabledFor } from "./flag.js";

test("enabled only for archetypes in the allowlist env", () => {
  expect(archetypeEnabledFor("smartphone", "smartphone")).toBe(true);
  expect(archetypeEnabledFor("laptop", "smartphone")).toBe(false);
  expect(archetypeEnabledFor("smartphone", "")).toBe(false);     // flag off
  expect(archetypeEnabledFor("unknown", "smartphone")).toBe(false);
});
