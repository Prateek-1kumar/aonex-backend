import { describe, it, expect } from "bun:test";
import { parseShopifyProbe } from "./shopify-probe.js";

describe("parseShopifyProbe", () => {
  it("returns facts when /products/<handle>.json responds OK", async () => {
    const fakeFetch = (async (_url: string) =>
      new Response(
        JSON.stringify({
          product: {
            title: "Tee",
            vendor: "Brand",
            variants: [
              { sku: "SKU-1", price: "19.99", inventory_quantity: 5, option1: "S" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const out = await parseShopifyProbe(
      "https://shop.example.com/products/tee",
      fakeFetch
    );
    expect(out.facts.find((f) => f.rawKey === "title")?.extractedValue).toBe("Tee");
    expect(out.facts.find((f) => f.rawKey === "variants[0].sku")?.extractedValue).toBe("SKU-1");
  });

  it("returns empty facts when path has no /products/<handle>", async () => {
    const out = await parseShopifyProbe("https://example.com/foo");
    expect(out.facts).toEqual([]);
  });
});
