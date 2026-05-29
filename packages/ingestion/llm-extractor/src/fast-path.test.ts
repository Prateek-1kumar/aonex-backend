import { test, expect } from "bun:test";
import { fieldsNeedingLlm, CONFIDENT } from "./fast-path.js";

test("LLM is asked only for fields missing or below the confidence bar", () => {
  const need = fieldsNeedingLlm(
    ["title", "brand", "base_price", "gtin"],
    {
      title: { value: "X", confidence: 0.95 },
      base_price: { value: 1, confidence: 0.6 },
    }
  );
  expect(need).toContain("brand");       // missing
  expect(need).toContain("gtin");        // missing
  expect(need).toContain("base_price");  // present but below CONFIDENT
  expect(need).not.toContain("title");   // present & confident -> fast path wins
});

test("CONFIDENT bar is explicit", () => {
  expect(CONFIDENT).toBe(0.9);
});
