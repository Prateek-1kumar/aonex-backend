import { test, expect } from "bun:test";
import { fieldsMatch } from "./normalize.js";

test("price matches within a 1% tolerance", () => {
  expect(fieldsMatch("base_price", 79999, 79999)).toBe(true);
  expect(fieldsMatch("base_price", 79999, 80000)).toBe(true); // <1%
  expect(fieldsMatch("base_price", 79999, 71000)).toBe(false); // >1%
});

test("strings match case/space/punctuation-insensitively", () => {
  expect(fieldsMatch("brand", "Google", "  google ")).toBe(true);
  expect(fieldsMatch("title", "Pixel 10 5G", "PIXEL 10  5g")).toBe(true);
  expect(fieldsMatch("brand", "Google", "Samsung")).toBe(false);
});

test("missing extracted value never matches", () => {
  expect(fieldsMatch("title", "Pixel 10", null)).toBe(false);
});
