import { test, expect } from "bun:test";
import { authorityRank, canSourceWrite } from "./authority.js";

test("authorityRank: connector > csv > link > backfill > unknown", () => {
  expect(authorityRank("connector:shopify")).toBe(4);
  expect(authorityRank("csv")).toBe(3);
  expect(authorityRank("csv:upload-42")).toBe(3);
  expect(authorityRank("link:croma")).toBe(2);
  expect(authorityRank("backfill:icecat")).toBe(1);
  expect(authorityRank("mystery")).toBe(0);
  expect(authorityRank("")).toBe(0);
});

test("canSourceWrite: no current → always yes (first write)", () => {
  expect(canSourceWrite(null,      "link:croma")).toBe(true);
  expect(canSourceWrite(undefined, "backfill:icecat")).toBe(true);
  expect(canSourceWrite("",        "connector:shopify")).toBe(true);
});

test("canSourceWrite: lower-authority cannot overwrite higher", () => {
  expect(canSourceWrite("connector:shopify", "link:croma")).toBe(false);
  expect(canSourceWrite("csv:upload",        "backfill:icecat")).toBe(false);
  expect(canSourceWrite("link:croma",        "backfill:icecat")).toBe(false);
});

test("canSourceWrite: equal-or-higher authority can overwrite", () => {
  expect(canSourceWrite("link:croma",        "csv:upload")).toBe(true);
  expect(canSourceWrite("csv:upload",        "connector:shopify")).toBe(true);
  expect(canSourceWrite("link:croma",        "link:amazon")).toBe(true); // same rank
  expect(canSourceWrite("connector:shopify", "connector:amazon")).toBe(true);
});
