import { test, expect } from "bun:test";
import { evaluateGate, type GateInput } from "./evaluate-gate.js";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";

function obs(attributeCode: string, value: unknown): AdapterOutput["observations"][number] {
  return {
    attributeCode, target: "parent", channelCode: "web", localeCode: "_unscoped",
    source: "link", sourceRecordId: "r1", value, confidence: 1, observedAt: new Date()
  };
}

function output(over: Partial<AdapterOutput> = {}): AdapterOutput {
  return {
    observations: [obs("title", "Cool Tee"), obs("category_path", "Apparel > Tees")],
    pricingObservations: [{
      productHint: "p", channelCode: "web", locale: "_unscoped", source: "link",
      sourceRecordId: "r1", currency: "USD", tiers: [{ kind: "list", amount: 19.99 }],
      observedAt: new Date()
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
