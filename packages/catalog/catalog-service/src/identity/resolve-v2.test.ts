// packages/catalog/catalog-service/src/identity/resolve-v2.test.ts
import { test, expect } from "bun:test";
import { decideResolution } from "./resolve-v2.js";
import type { Identifier } from "./identifier-set.js";

const incoming: Identifier[] = [{ type: "gtin", value: "0123", source: "link:croma", corroborated: true }];

test("strong-key match with no variant conflict -> auto-merge", () => {
  const r = decideResolution({
    incomingIds: incoming,
    incomingVariant: { storage: "256GB" },
    candidates: [{
      productId: "p1",
      ids: [{ type: "gtin", value: "0123", source: "connector:shopify", corroborated: true }],
      variant: { storage: "256GB" },
    }],
  });
  expect(r.action).toBe("auto_merge");
  expect(r.productId).toBe("p1");
});

test("strong-key match BUT variant conflict -> propose to Lab (never auto-merge)", () => {
  const r = decideResolution({
    incomingIds: incoming,
    incomingVariant: { storage: "128GB" },
    candidates: [{
      productId: "p1",
      ids: [{ type: "gtin", value: "0123", source: "connector:shopify", corroborated: true }],
      variant: { storage: "256GB" },
    }],
  });
  expect(r.action).toBe("propose_lab");
});

test("no strong match, only fuzzy candidate -> propose to Lab, never auto", () => {
  const r = decideResolution({
    incomingIds: [{ type: "gtin", value: "9999", source: "backfill:icecat", corroborated: false }],
    incomingVariant: {},
    candidates: [{
      productId: "p2",
      ids: [{ type: "gtin", value: "0123", source: "connector:shopify", corroborated: true }],
      variant: {},
      fuzzyScore: 0.82,
    }],
  });
  expect(r.action).toBe("propose_lab");
});

test("no candidates -> create new (no Lab)", () => {
  const r = decideResolution({ incomingIds: incoming, incomingVariant: {}, candidates: [] });
  expect(r.action).toBe("create_new");
});
