import { test, expect } from "bun:test";
import { wouldAutoMerge, mergeMetrics, loadIdentityPairs, type IdentityPair } from "./merge-pairs.js";

const samePair: IdentityPair = {
  id: "p1", label: "same",
  a: { identifiers: [{ type: "gtin", value: "X", source: "connector:shopify", corroborated: true }], variant: { storage: "256GB" } },
  b: { identifiers: [{ type: "gtin", value: "X", source: "link:croma",        corroborated: true }], variant: { storage: "256GB" } },
};

const diffPair: IdentityPair = {
  id: "p2", label: "different",
  a: { identifiers: [{ type: "gtin", value: "X", source: "connector:shopify", corroborated: true }], variant: { storage: "256GB" } },
  b: { identifiers: [{ type: "gtin", value: "Y", source: "link:amazon",       corroborated: true }], variant: { storage: "256GB" } },
};

const variantConflictPair: IdentityPair = {
  id: "p3", label: "different",
  a: { identifiers: [{ type: "gtin", value: "X", source: "connector:shopify", corroborated: true }], variant: { storage: "128GB" } },
  b: { identifiers: [{ type: "gtin", value: "X", source: "link:croma",        corroborated: true }], variant: { storage: "256GB" } },
};

test("wouldAutoMerge: shared strong key + no variant conflict → true", () => {
  expect(wouldAutoMerge(samePair.a, samePair.b)).toBe(true);
});

test("wouldAutoMerge: different strong keys → false", () => {
  expect(wouldAutoMerge(diffPair.a, diffPair.b)).toBe(false);
});

test("wouldAutoMerge: shared strong key but variant conflict → false", () => {
  expect(wouldAutoMerge(variantConflictPair.a, variantConflictPair.b)).toBe(false);
});

test("mergeMetrics: zero wrong auto-merges on the canonical pair set", () => {
  const m = mergeMetrics([samePair, diffPair, variantConflictPair]);
  expect(m.autoMerged).toBe(1);
  expect(m.wrongAutoMerges).toBe(0);
  expect(m.mergePrecision).toBe(1);
});

test("loadIdentityPairs reads the seed fixtures with both labels", async () => {
  const dir = `${import.meta.dir}/../fixtures/identity-pairs`;
  const { pairs, errors } = await loadIdentityPairs(dir);
  expect(errors).toEqual([]);
  expect(pairs.length).toBeGreaterThanOrEqual(2);
  expect(pairs.some((p) => p.label === "same")).toBe(true);
  expect(pairs.some((p) => p.label === "different")).toBe(true);
});
