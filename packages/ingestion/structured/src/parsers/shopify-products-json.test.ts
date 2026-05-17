import { describe, it, expect } from "bun:test";
import { parseShopifyProductsJson } from "./shopify-products-json.js";

const PRODUCT_PAYLOAD = {
  product: {
    id: 7654321,
    title: "Aonami Pro Drill",
    vendor: "Aonami",
    body_html: "<p>A powerful cordless drill</p>",
    handle: "aonami-pro-drill",
    product_type: "Power Tools",
    variants: [
      {
        id: 111,
        sku: "APD-001",
        price: "199.99",
        barcode: "1234567890123",
        option1: "Blue",
      },
      {
        id: 222,
        sku: "APD-002",
        price: "219.99",
        barcode: "1234567890130",
        option1: "Red",
      },
    ],
    options: [{ name: "Color", values: ["Blue", "Red"] }],
    images: [],
  },
};

function makeFetch(
  status: number,
  body: unknown
): typeof fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(
      status === 200 ? JSON.stringify(body) : "",
      { status, headers: { "content-type": "application/json" } }
    )) as unknown as typeof fetch;
}

function makeThrowingFetch(): typeof fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    throw new Error("Network error");
  }) as unknown as typeof fetch;
}

describe("parseShopifyProductsJson", () => {
  it("non-Shopify URL (no /products/<handle>) returns empty facts immediately", async () => {
    const result = await parseShopifyProductsJson(
      "https://example.com/about",
      { fetchImpl: makeFetch(200, PRODUCT_PAYLOAD) }
    );
    expect(result.kind).toBe("shopify_products_json");
    expect(result.facts).toEqual([]);
    expect(result.baselineConfidence).toBe(0.95);
  });

  it("Shopify product URL + valid JSON → extracts 4+ facts including title, brand, base_price, gtin", async () => {
    const result = await parseShopifyProductsJson(
      "https://shop.example.com/products/aonami-pro-drill",
      { fetchImpl: makeFetch(200, PRODUCT_PAYLOAD) }
    );
    expect(result.kind).toBe("shopify_products_json");
    expect(result.facts.length).toBeGreaterThanOrEqual(4);

    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Aonami Pro Drill");
    expect(byKey("brand")?.extractedValue).toBe("Aonami");
    expect(byKey("base_price")?.extractedValue).toBe(199.99);
    expect(byKey("gtin")?.extractedValue).toBe("1234567890123");
  });

  it("Shopify URL + network error → empty facts (graceful degradation)", async () => {
    const result = await parseShopifyProductsJson(
      "https://shop.example.com/products/aonami-pro-drill",
      { fetchImpl: makeThrowingFetch() }
    );
    expect(result.kind).toBe("shopify_products_json");
    expect(result.facts).toEqual([]);
  });

  it("Shopify URL + 404 response → empty facts", async () => {
    const result = await parseShopifyProductsJson(
      "https://shop.example.com/products/unknown-product",
      { fetchImpl: makeFetch(404, null) }
    );
    expect(result.kind).toBe("shopify_products_json");
    expect(result.facts).toEqual([]);
  });

  it("all emitted facts use extractionMethod=direct", async () => {
    const result = await parseShopifyProductsJson(
      "https://shop.example.com/products/aonami-pro-drill",
      { fetchImpl: makeFetch(200, PRODUCT_PAYLOAD) }
    );
    for (const f of result.facts) {
      expect(f.extractionMethod).toBe("direct");
    }
  });

  it("extracts description and category_path facts", async () => {
    const result = await parseShopifyProductsJson(
      "https://shop.example.com/products/aonami-pro-drill",
      { fetchImpl: makeFetch(200, PRODUCT_PAYLOAD) }
    );
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("description")?.extractedValue).toBe("<p>A powerful cordless drill</p>");
    expect(byKey("category_path")?.extractedValue).toBe("Power Tools");
  });

  it("baselineConfidence is 0.95", async () => {
    const result = await parseShopifyProductsJson(
      "https://shop.example.com/products/aonami-pro-drill",
      { fetchImpl: makeFetch(200, PRODUCT_PAYLOAD) }
    );
    expect(result.baselineConfidence).toBe(0.95);
  });
});
