import { describe, expect, test } from "bun:test";
import { buildVerifyContext, verifyField } from "./verify.js";
import type { SourceProduct } from "./types.js";

const product: SourceProduct = {
  title: "Sony WH-1000XM5 Wireless Headphones Black",
  brand: "Sony",
  sourceCategory: "Men's Audio > Headphones",
  knownAttrs: { color: "black" },
};
const ctx = buildVerifyContext(product);

describe("verifyField grounding", () => {
  test("value present in title -> grounded", () => {
    const v = verifyField({ key: "color", value: "Black", confidence: 0.9 }, ctx);
    expect(v.grounding).toBe("grounded");
    expect(v.support).toBeGreaterThanOrEqual(0.9);
  });

  test("known source value echoed -> grounded", () => {
    const v = verifyField({ key: "color", value: "black", confidence: 0.8 }, ctx);
    expect(v.grounding).toBe("grounded");
  });

  test("conflicts with a known value -> contradicted", () => {
    const v = verifyField({ key: "color", value: "white", confidence: 0.95 }, ctx);
    expect(v.grounding).toBe("contradicted");
    expect(v.support).toBe(0);
  });

  test("world-knowledge value not in source -> inferred", () => {
    const v = verifyField({ key: "connectivity", value: "Bluetooth", confidence: 0.9 }, ctx);
    expect(v.grounding).toBe("inferred");
  });

  test("gender derivable from source category -> grounded", () => {
    const v = verifyField({ key: "target-gender", value: "Men", confidence: 0.7 }, ctx);
    expect(v.grounding).toBe("grounded");
  });

  test("numeric spec present in source -> grounded", () => {
    const ctx2 = buildVerifyContext({ title: "iPhone 15 128GB" });
    const v = verifyField({ key: "storage", value: "128GB", confidence: 0.9 }, ctx2);
    expect(v.grounding).toBe("grounded");
  });
});
