import { test, expect } from "bun:test";
import * as a from "./index.js";

test("public surface", () => {
  for (const n of [
    "getArchetype", "listArchetypes", "registerArchetype",
    "classifyArchetype", "scoreCompleteness", "hardFloorOk",
    "archetypeEnabledFor",
  ])
    expect(typeof (a as Record<string, unknown>)[n]).toBe("function");
});
