import { test, expect } from "bun:test";
import type { AdapterOutput, PricingObservation } from "@aonex/catalog-source-adapters";
import { __applyFillsForTest as applyFills } from "./promote-staged.js";

test("a price fill adds a primary pricing observation that satisfies the gate", () => {
  const base: AdapterOutput = {
    observations: [],
    pricingObservations: [],
    inventoryObservations: [],
    identityHint: { brand: "Google", gtin: "X", targetIsVariant: false },
    rawPayload: null,
  };
  const filled = applyFills(base, { price: "79999", currency: "INR", channelCode: "croma" }, null);
  expect(filled.pricingObservations.length).toBe(1);
  const p = filled.pricingObservations[0] as PricingObservation;
  expect(p.currency).toBe("INR");
  expect(p.tiers[0]!.amount).toBe(79999);
  expect(p.tiers[0]!.kind).toBe("list");
  expect(p.channelCode).toBe("croma");
  expect(p.source).toBe("manual:lab");
});

test("a currency fill alone is consumed (no synthetic observation, no pricing observation)", () => {
  const base: AdapterOutput = {
    observations: [],
    pricingObservations: [],
    inventoryObservations: [],
    identityHint: { brand: "Google", gtin: "X", targetIsVariant: false },
    rawPayload: null,
  };
  const filled = applyFills(base, { currency: "INR" }, null);
  expect(filled.pricingObservations.length).toBe(0);
  expect(filled.observations.length).toBe(0); // not a synthetic observation either
});
