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

test("price fill reuses an existing pricing obs's channel when no staged/fills channel is set", () => {
  // Regression guard: pricing FKs to channels.channel_id, so we must NEVER
  // invent a synthetic code like "manual" that doesn't exist as a row.
  const base: AdapterOutput = {
    observations: [],
    pricingObservations: [
      {
        productHint: "p",
        channelCode: "nike-in",
        locale: "_unscoped",
        source: "link:nike",
        sourceRecordId: "r1",
        currency: "INR",
        tiers: [{ kind: "list", amount: 5000 }],
        observedAt: new Date(),
      },
    ],
    inventoryObservations: [],
    identityHint: { brand: "Nike", gtin: "X", targetIsVariant: false },
    rawPayload: null,
  };
  const filled = applyFills(base, { price: "4788", currency: "INR" }, null);
  expect(filled.pricingObservations.length).toBe(2);
  const labFill = filled.pricingObservations.find((p) => p.source === "manual:lab");
  expect(labFill).toBeDefined();
  expect(labFill!.channelCode).toBe("nike-in");
  expect(labFill!.channelCode).not.toBe("manual");
});

test("price fill falls back to an observation's channel when no pricing obs exists", () => {
  const base: AdapterOutput = {
    observations: [
      {
        attributeCode: "title",
        target: "parent",
        channelCode: "amazon-in",
        localeCode: "en_IN",
        source: "link:amazon",
        sourceRecordId: "r1",
        value: "Some Product",
        confidence: 0.9,
        observedAt: new Date(),
      },
    ],
    pricingObservations: [],
    inventoryObservations: [],
    identityHint: { brand: "X", targetIsVariant: false },
    rawPayload: null,
  };
  const filled = applyFills(base, { price: "100", currency: "INR" }, null);
  expect(filled.pricingObservations.length).toBe(1);
  expect(filled.pricingObservations[0]!.channelCode).toBe("amazon-in");
});

test("price fill last-resort falls back to _unscoped (never 'manual')", () => {
  const base: AdapterOutput = {
    observations: [],
    pricingObservations: [],
    inventoryObservations: [],
    identityHint: { brand: "X", targetIsVariant: false },
    rawPayload: null,
  };
  const filled = applyFills(base, { price: "100", currency: "INR" }, null);
  expect(filled.pricingObservations[0]!.channelCode).toBe("_unscoped");
  expect(filled.pricingObservations[0]!.channelCode).not.toBe("manual");
});
