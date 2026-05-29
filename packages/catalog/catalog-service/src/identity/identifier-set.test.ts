import { test, expect } from "bun:test";
import {
  identifierStrength,
  matchOnStrong,
  upsertIdentifier,
  type Identifier,
} from "./identifier-set.js";

// ---- Strength tiers ---------------------------------------------------------

test("strength tiers: gtin/mpn+brand strong; asin namespace-scoped; backfill weak", () => {
  expect(identifierStrength({ type: "gtin", value: "X", source: "connector:shopify", corroborated: true })).toBe("strong");
  expect(identifierStrength({ type: "asin", value: "B0...", source: "connector:amazon" })).toBe("namespace");
  expect(identifierStrength({ type: "merchant_sku", value: "SKU-1", source: "csv" })).toBe("tenant");
  expect(identifierStrength({ type: "gtin", value: "X", source: "backfill:icecat", corroborated: false })).toBe("weak");
  expect(identifierStrength({ type: "gtin", value: "X", source: "backfill:icecat", corroborated: true })).toBe("strong");
});

test("matchOnStrong matches when a STRONG key value coincides", () => {
  const a: Identifier[] = [{ type: "gtin", value: "0123", source: "connector:shopify", corroborated: true }];
  const b: Identifier[] = [{ type: "gtin", value: "0123", source: "link:croma", corroborated: true }];
  expect(matchOnStrong(a, b)).toBe(true);
});

test("matchOnStrong does NOT match on a weak/backfill key alone", () => {
  const a: Identifier[] = [{ type: "gtin", value: "0123", source: "backfill:icecat", corroborated: false }];
  const b: Identifier[] = [{ type: "gtin", value: "0123", source: "backfill:upcitemdb", corroborated: false }];
  expect(matchOnStrong(a, b)).toBe(false);
});

// ---- upsertIdentifier (the review-hardening invariant) ---------------------

test("upsertIdentifier 'added' on a fresh (type, value)", () => {
  const r = upsertIdentifier([], { type: "gtin", value: "X", source: "connector:shopify" });
  expect(r.kind).toBe("added");
  expect(r.set.length).toBe(1);
});

test("upsertIdentifier 'unchanged' on an exact duplicate", () => {
  const existing: Identifier = { type: "gtin", value: "X", source: "connector:shopify" };
  const r = upsertIdentifier([existing], existing);
  expect(r.kind).toBe("unchanged");
  expect(r.set).toEqual([existing]);
});

test("upsertIdentifier 'promoted' when a stronger source overwrites the same (type, value)", () => {
  const weak: Identifier = { type: "gtin", value: "X", source: "backfill:icecat", corroborated: false };
  const strong: Identifier = { type: "gtin", value: "X", source: "connector:shopify" };
  const r = upsertIdentifier([weak], strong);
  expect(r.kind).toBe("promoted");
  expect(r.set[0]!.source).toBe("connector:shopify");
});

test("upsertIdentifier 'conflict' on a second STRONG value of the same type", () => {
  const a: Identifier = { type: "gtin", value: "AAA", source: "connector:shopify" };
  const b: Identifier = { type: "gtin", value: "BBB", source: "connector:amazon" };
  const r = upsertIdentifier([a], b);
  expect(r.kind).toBe("conflict");
  if (r.kind === "conflict") {
    expect(r.existing.value).toBe("AAA");
    expect(r.incoming.value).toBe("BBB");
    expect(r.set).toEqual([a]);  // set NOT mutated on conflict
  }
});

test("upsertIdentifier allows multiple CANDIDATE values of the same type to coexist", () => {
  const a: Identifier = { type: "gtin", value: "AAA", source: "backfill:icecat", corroborated: false };
  const b: Identifier = { type: "gtin", value: "BBB", source: "backfill:upcitemdb", corroborated: false };
  const r1 = upsertIdentifier([a], b);
  expect(r1.kind).toBe("added");
  expect(r1.set.length).toBe(2);
});
