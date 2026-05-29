import { test, expect } from "bun:test";
import { scorePair } from "./pair-features.js";

test("same title embedding + matching specs + close price => high score", () => {
  const s = scorePair(
    { titleEmbedding: [1, 0], specs: { storage: "256GB" }, price: 79999 },
    { titleEmbedding: [1, 0], specs: { storage: "256GB" }, price: 80000 }
  );
  expect(s.composite).toBeGreaterThan(0.8);
});

test("matching title but conflicting specs => penalized below merge band", () => {
  const s = scorePair(
    { titleEmbedding: [1, 0], specs: { storage: "128GB" }, price: 70000 },
    { titleEmbedding: [1, 0], specs: { storage: "256GB" }, price: 80000 }
  );
  expect(s.composite).toBeLessThan(0.5);
});
