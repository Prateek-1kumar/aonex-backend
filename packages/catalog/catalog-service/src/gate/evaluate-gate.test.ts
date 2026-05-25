import { test, expect } from "bun:test";
import { evaluateGate, type GateInput } from "./evaluate-gate.js";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";

// Fixed timestamp so the obs() factory is deterministic (matters if a future
// test exercises attrValue's latest-by-observedAt tie-breaking).
const T = new Date("2026-01-01T00:00:00Z");

function obs(attributeCode: string, value: unknown): AdapterOutput["observations"][number] {
  return {
    attributeCode, target: "parent", channelCode: "web", localeCode: "_unscoped",
    source: "link", sourceRecordId: "r1", value, confidence: 1, observedAt: T
  };
}

function output(over: Partial<AdapterOutput> = {}): AdapterOutput {
  return {
    observations: [obs("title", "Cool Tee"), obs("category_path", "Apparel > Tees")],
    pricingObservations: [{
      productHint: "p", channelCode: "web", locale: "_unscoped", source: "link",
      sourceRecordId: "r1", currency: "USD", tiers: [{ kind: "list", amount: 19.99 }],
      observedAt: T
    }],
    inventoryObservations: [],
    identityHint: { gtin: "12345678905", brand: "Acme", titleForFuzzy: "Cool Tee", targetIsVariant: false },
    rawPayload: {},
    ...over
  };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return { adapterOutput: output(), signals: [], ...over };
}

test("complete output → admit", () => {
  const v = evaluateGate(input());
  expect(v.admit).toBe(true);
  expect(v.missingFields).toEqual([]);
});

test("missing brand + identifier → hold with those fields", () => {
  const v = evaluateGate(input({
    adapterOutput: output({
      observations: [obs("title", "Cool Tee"), obs("category_path", "Apparel > Tees")],
      identityHint: { titleForFuzzy: "Cool Tee", targetIsVariant: false }
    })
  }));
  expect(v.admit).toBe(false);
  expect(v.missingFields.sort()).toEqual(["brand", "identifier"]);
});

test("gtin present + brand absent → missing 'brand' only, identifier satisfied", () => {
  // Locks the independence of brand and identifier: a hard ID (gtin) satisfies
  // 'identifier', so brand-absent flags ONLY 'brand', never 'identifier'.
  const v = evaluateGate(input({
    adapterOutput: output({
      identityHint: { gtin: "12345678905", titleForFuzzy: "Cool Tee", targetIsVariant: false }
    })
  }));
  expect(v.missingFields).toEqual(["brand"]);
  expect(v.missingFields).not.toContain("identifier");
});

test("brand present but no gtin/mpn → missing 'identifier' (brand is not an identifier)", () => {
  const v = evaluateGate(input({
    adapterOutput: output({
      identityHint: { brand: "Acme", titleForFuzzy: "Cool Tee", targetIsVariant: false }
    })
  }));
  expect(v.missingFields).toEqual(["identifier"]);
  expect(v.missingFields).not.toContain("brand");
});

test("empty/whitespace title does not count as present", () => {
  const v = evaluateGate(input({
    adapterOutput: output({ observations: [obs("title", "  "), obs("category_path", "x")] })
  }));
  expect(v.missingFields).toContain("title");
});

test("a blocking signal holds an otherwise-complete product", () => {
  const v = evaluateGate(input({
    signals: [{ signalKind: "identity_conflict", severity: "high", blocking: true }]
  }));
  expect(v.admit).toBe(false);
  expect(v.blockingSignals).toHaveLength(1);
});

test("a non-blocking signal does not hold a complete product", () => {
  const v = evaluateGate(input({
    signals: [{ signalKind: "low_confidence_mapping", severity: "low", blocking: false }]
  }));
  expect(v.admit).toBe(true);
  expect(v.infoSignals).toHaveLength(1);
});
