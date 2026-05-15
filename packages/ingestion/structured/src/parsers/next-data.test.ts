import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanHtml } from "@aonex/ingestion-link-fetcher";
import { parseNextData } from "./next-data.js";

const bewakoofHtml = readFileSync(
  join(__dirname, "../../test/fixtures/bewakoof.html"),
  "utf8"
);

describe("parseNextData", () => {
  it("extracts title, price, mrp from Bewakoof productDetails", () => {
    const { structuredBlocks } = cleanHtml(bewakoofHtml);
    const out = parseNextData(structuredBlocks.nextData);
    const byKey = (k: string) => out.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toContain("Vengeance");
    expect(byKey("base_price")?.extractedValue).toBe(699);
    expect(byKey("mrp")?.extractedValue).toBe(1299);
  });

  it("emits per-variant facts: size, sku, inventory", () => {
    const { structuredBlocks } = cleanHtml(bewakoofHtml);
    const out = parseNextData(structuredBlocks.nextData);
    const sizeKeys = out.facts.filter((f) =>
      /^variants\[\d+\]\.option\.size$/.test(f.rawKey)
    );
    const skuKeys = out.facts.filter((f) =>
      /^variants\[\d+\]\.sku$/.test(f.rawKey)
    );
    const invKeys = out.facts.filter((f) =>
      /^variants\[\d+\]\.inventory_quantity$/.test(f.rawKey)
    );
    expect(sizeKeys.length).toBe(6);
    expect(skuKeys.length).toBe(6);
    expect(invKeys.length).toBe(6);
  });

  it("assigns confidence=0.85 and extractionMethod=direct", () => {
    const { structuredBlocks } = cleanHtml(bewakoofHtml);
    const out = parseNextData(structuredBlocks.nextData);
    for (const f of out.facts) {
      expect(f.confidence).toBeCloseTo(0.85, 2);
      expect(f.extractionMethod).toBe("direct");
    }
  });

  it("returns empty facts on null input", () => {
    const out = parseNextData(null);
    expect(out.facts).toEqual([]);
  });

  describe("Shopify Hydrogen shape (variants.nodes[] + selectedOptions)", () => {
    const hydrogenBlob: Record<string, unknown> = {
      props: {
        pageProps: {
          product: {
            id: "gid://shopify/Product/123",
            title: "Acme Linen Shirt",
            vendor: "Acme Apparel",
            description: "Lightweight 100% linen.",
            options: [
              { name: "Color", values: ["Sand", "Navy"] },
              { name: "Size", values: ["S", "M", "L"] },
            ],
            variants: {
              nodes: [
                {
                  id: "gid://shopify/ProductVariant/1",
                  sku: "ACM-SAND-S",
                  selectedOptions: [
                    { name: "Color", value: "Sand" },
                    { name: "Size", value: "S" },
                  ],
                  price: { amount: "59.95", currencyCode: "AUD" },
                  quantityAvailable: 5,
                },
                {
                  id: "gid://shopify/ProductVariant/2",
                  sku: "ACM-SAND-M",
                  selectedOptions: [
                    { name: "Color", value: "Sand" },
                    { name: "Size", value: "M" },
                  ],
                  price: { amount: "59.95", currencyCode: "AUD" },
                  quantityAvailable: 0,
                },
                {
                  id: "gid://shopify/ProductVariant/3",
                  sku: "ACM-NAVY-L",
                  selectedOptions: [
                    { name: "Color", value: "Navy" },
                    { name: "Size", value: "L" },
                  ],
                  price: { amount: "69.95", currencyCode: "AUD" },
                  quantityAvailable: 8,
                },
              ],
            },
          },
        },
      },
    };

    it("discovers Shopify Hydrogen product and extracts title + brand", () => {
      const out = parseNextData(hydrogenBlob);
      const byKey = (k: string) => out.facts.find((f) => f.rawKey === k);
      expect(byKey("title")?.extractedValue).toBe("Acme Linen Shirt");
      expect(byKey("brand")?.extractedValue).toBe("Acme Apparel");
    });

    it("emits color and size axis values from selectedOptions for each variant", () => {
      const out = parseNextData(hydrogenBlob);
      const colors = out.facts
        .filter((f) => /^variants\[\d+\]\.option\.color$/.test(f.rawKey))
        .map((f) => String(f.extractedValue));
      const sizes = out.facts
        .filter((f) => /^variants\[\d+\]\.option\.size$/.test(f.rawKey))
        .map((f) => String(f.extractedValue));
      expect(colors).toEqual(["Sand", "Sand", "Navy"]);
      expect(sizes).toEqual(["S", "M", "L"]);
    });

    it("emits per-variant sku, price, and inventory_quantity", () => {
      const out = parseNextData(hydrogenBlob);
      const skus = out.facts
        .filter((f) => /^variants\[\d+\]\.sku$/.test(f.rawKey))
        .map((f) => String(f.extractedValue));
      const prices = out.facts
        .filter((f) => /^variants\[\d+\]\.price$/.test(f.rawKey))
        .map((f) => Number(f.extractedValue));
      const inv = out.facts
        .filter((f) => /^variants\[\d+\]\.inventory_quantity$/.test(f.rawKey))
        .map((f) => Number(f.extractedValue));
      expect(skus).toEqual(["ACM-SAND-S", "ACM-SAND-M", "ACM-NAVY-L"]);
      expect(prices).toEqual([59.95, 59.95, 69.95]);
      expect(inv).toEqual([5, 0, 8]);
    });

    it("emits top-level currency from the first variant's currencyCode", () => {
      const out = parseNextData(hydrogenBlob);
      expect(
        out.facts.find((f) => f.rawKey === "currency")?.extractedValue
      ).toBe("AUD");
    });
  });

  describe("generic shape discovery (no English keys)", () => {
    it("discovers a product subtree with non-Bewakoof key names", () => {
      const blob = {
        layout: {
          state: {
            pdp: {
              productInfo: {
                title: "Generic Widget",
                sellingPrice: 1499,
                listPrice: 1999,
                skus: [
                  { id: "GW-1", optionLabel: "Small" },
                  { id: "GW-2", optionLabel: "Large" },
                ],
              },
            },
          },
        },
      };
      const out = parseNextData(blob);
      expect(out.facts.find((f) => f.rawKey === "title")?.extractedValue).toBe(
        "Generic Widget"
      );
      expect(
        out.facts.find((f) => f.rawKey === "base_price")?.extractedValue
      ).toBe(1499);
    });
  });
});
