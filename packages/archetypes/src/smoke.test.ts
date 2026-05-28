import { test, expect } from "bun:test";
import { ARCHETYPES_PACKAGE } from "./index.js";

test("importable", () => {
  expect(ARCHETYPES_PACKAGE).toBe("@aonex/archetypes");
});
