import { test, expect } from "bun:test";
import { variantConflict } from "./variant-guard.js";

test("differing storage blocks a merge", () => {
  expect(variantConflict({ storage: "128GB" }, { storage: "256GB" })).toBe(true);
});

test("same/absent variant keys do not conflict", () => {
  expect(variantConflict({ storage: "256GB" }, { storage: "256GB" })).toBe(false);
  expect(variantConflict({}, { color: "Obsidian" })).toBe(false); // unknown on one side
});

test("region difference blocks a merge", () => {
  expect(variantConflict({ region: "IN" }, { region: "US" })).toBe(true);
});
