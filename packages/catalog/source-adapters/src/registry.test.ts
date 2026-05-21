import { expect, test } from "bun:test";
import type { SourceAdapter } from "./types.js";
import { getAdapter, registerAdapter } from "./registry.js";

test("getAdapter returns registered adapter by source_kind", () => {
  const fake: SourceAdapter = { sourceKind: "fake", adapt: () => ({} as any) };
  registerAdapter(fake);
  expect(getAdapter("fake")).toBe(fake);
});

test("getAdapter throws for unknown source_kind", () => {
  expect(() => getAdapter("nonexistent")).toThrow();
});
