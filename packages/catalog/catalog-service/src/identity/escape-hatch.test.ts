import { test, expect } from "bun:test";
import { identitySatisfied } from "./escape-hatch.js";

test("identity satisfied by a present strong id", () => {
  expect(identitySatisfied([{ type: "gtin", value: "X", source: "link:croma", corroborated: true }], true)).toBe(true);
});

test("identity satisfied by explicit identifier_exists=false", () => {
  expect(identitySatisfied([], false)).toBe(true);
});

test("no id and claims one exists -> not satisfied", () => {
  expect(identitySatisfied([], true)).toBe(false);
});
