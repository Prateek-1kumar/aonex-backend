import { test, expect } from "bun:test";
import { fieldWeight, CRITICAL_FIELDS } from "./field-weights.js";

test("identity and price are critical (weight 1.0)", () => {
  expect(fieldWeight("base_price")).toBe(1);
  expect(fieldWeight("gtin")).toBe(1);
  expect(CRITICAL_FIELDS.has("base_price")).toBe(true);
});

test("description and extra fields weigh far less than price", () => {
  expect(fieldWeight("description_long")).toBeLessThan(fieldWeight("base_price"));
  expect(fieldWeight("title")).toBeGreaterThan(fieldWeight("description_long"));
});

test("unknown field gets a low default weight", () => {
  expect(fieldWeight("some_random_attr")).toBe(0.2);
});
