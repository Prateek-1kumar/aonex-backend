import { describe, it, expect } from "bun:test";
import { validatePricing, validateGtin, dedupeVariantSkus } from "./sanity-validators.js";

describe("validatePricing", () => {
  it("swaps when sale_price > list_price", () => {
    const r = validatePricing({ list_price: 80, sale_price: 100, currency: "USD" });
    expect(r.value.list_price).toBe(100);
    expect(r.value.sale_price).toBe(80);
    expect(r.warnings[0]?.field).toBe("pricing");
  });

  it("nulls list_price <= 0", () => {
    const r = validatePricing({ list_price: 0, sale_price: null, currency: "USD" });
    expect(r.value.list_price).toBeNull();
    expect(r.warnings[0]?.field).toBe("pricing.list_price");
  });

  it("passes when valid", () => {
    const r = validatePricing({ list_price: 100, sale_price: 80, currency: "USD" });
    expect(r.warnings).toHaveLength(0);
    expect(r.value.list_price).toBe(100);
    expect(r.value.sale_price).toBe(80);
  });

  it("passes when sale_price is null", () => {
    const r = validatePricing({ list_price: 100, sale_price: null, currency: "USD" });
    expect(r.warnings).toHaveLength(0);
  });
});

describe("validateGtin", () => {
  it("accepts valid UPC-A checksum", () => {
    // 036000291452 is a valid UPC-A (real Procter & Gamble code)
    const r = validateGtin("036000291452");
    expect(r.warnings).toHaveLength(0);
    expect(r.value).toBe("036000291452");
  });

  it("flags wrong checksum", () => {
    const r = validateGtin("036000291451");
    expect(r.warnings.some((w) => w.reason === "checksum failed")).toBe(true);
  });

  it("flags non-numeric format", () => {
    const r = validateGtin("abc123");
    expect(r.warnings[0]?.reason).toBe("format invalid");
  });

  it("handles null", () => {
    const r = validateGtin(null);
    expect(r.value).toBeNull();
    expect(r.warnings).toHaveLength(0);
  });
});

describe("dedupeVariantSkus", () => {
  it("dedupes duplicate SKUs", () => {
    const r = dedupeVariantSkus([
      { sku: "A" }, { sku: "B" }, { sku: "A" }
    ]);
    expect(r.value).toHaveLength(2);
    expect(r.warnings[0]?.reason).toContain("duplicate sku A");
  });

  it("keeps variants with null sku", () => {
    const r = dedupeVariantSkus([
      { sku: "A" }, { sku: null }, { sku: null }
    ]);
    expect(r.value).toHaveLength(3);
  });

  it("returns no warnings when all unique", () => {
    const r = dedupeVariantSkus([{ sku: "A" }, { sku: "B" }]);
    expect(r.warnings).toHaveLength(0);
  });
});
