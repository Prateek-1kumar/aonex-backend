import { test, expect } from "bun:test";
import { evaluateCompleteness } from "./completeness-gate.js";

const out = {
  observations: [
    { attributeCode: "title", channelCode: "croma", locale: "en", value: "Pixel 10", confidence: 0.9, observedAt: new Date() },
    { attributeCode: "category_path", channelCode: "croma", locale: "en", value: "x", confidence: 0.5, observedAt: new Date() },
  ],
  identityHint: { brand: "Google", targetIsVariant: false }, // no price, no identifier
  pricingObservations: [],
  inventoryObservations: [],
  rawPayload: null,
} as any;

test("smartphone with no price -> below threshold, gap lists price + identifier", () => {
  const v = evaluateCompleteness({ adapterOutput: out, archetypeId: "smartphone", threshold: 0.8, identifierExists: true });
  expect(v.admit).toBe(false);
  expect(v.missingRequired).toContain("base_price");
  expect(v.missingRequired).toContain("identifier");
});
