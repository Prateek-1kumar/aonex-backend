import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonLd } from "./json-ld.js";
import { cleanHtml } from "@aonex/ingestion-link-fetcher";

const decathlonHtml = readFileSync(
  join(__dirname, "../../test/fixtures/decathlon.html"),
  "utf8"
);

describe("parseJsonLd", () => {
  it("extracts title, brand, price, currency from Decathlon Product block", () => {
    const { structuredBlocks } = cleanHtml(decathlonHtml);
    const output = parseJsonLd(structuredBlocks.jsonLd);
    const facts = output.facts;
    const byKey = (k: string) => facts.find((f) => f.rawKey === k);

    expect(byKey("title")?.extractedValue).toContain("Ekiden One");
    expect(byKey("brand")?.extractedValue).toBe("DECATHLON");
    expect(byKey("base_price")?.extractedValue).toBe(999);
    expect(byKey("currency")?.extractedValue).toBe("INR");
    expect(byKey("mpn")?.extractedValue).toBe("8351755");
  });

  it("captures size variant axis from JSON-LD Product.size[]", () => {
    const { structuredBlocks } = cleanHtml(decathlonHtml);
    const output = parseJsonLd(structuredBlocks.jsonLd);
    const sizes = output.facts.filter((f) =>
      /^variants\[\d+\]\.option\.size$/.test(f.rawKey)
    );
    expect(sizes.length).toBe(10);
    const sizeValues = sizes.map((f) => f.extractedValue);
    expect(sizeValues).toEqual(
      expect.arrayContaining(["5.5", "6.5", "7", "8", "8.5", "9.5", "10.5", "11", "12", "12.5"])
    );
  });

  it("captures BreadcrumbList as canonical category candidate", () => {
    const { structuredBlocks } = cleanHtml(decathlonHtml);
    const output = parseJsonLd(structuredBlocks.jsonLd);
    const cat = output.facts.find((f) => f.rawKey === "productType");
    expect(cat?.extractedValue).toContain("Running Shoes");
  });

  it("assigns confidence=0.95 to all emitted facts", () => {
    const { structuredBlocks } = cleanHtml(decathlonHtml);
    const output = parseJsonLd(structuredBlocks.jsonLd);
    for (const f of output.facts) {
      expect(f.confidence).toBeCloseTo(0.95, 2);
      expect(f.extractionMethod).toBe("direct");
    }
  });

  it("returns empty facts when no Product block exists", () => {
    const output = parseJsonLd([
      { "@context": "https://schema.org", "@type": "WebSite", name: "site" } as Record<
        string,
        unknown
      >,
    ]);
    expect(output.facts).toEqual([]);
  });

  describe("ProductGroup hasVariant walk", () => {
    const adidasLikeBlocks: Record<string, unknown>[] = [
      {
        "@context": "https://schema.org",
        "@type": "ProductGroup",
        name: "Ultraboost 22",
        brand: { "@type": "Brand", name: "Adidas" },
        productGroupID: "UB22-GROUP",
        variesBy: ["color", "size"],
        hasVariant: [
          {
            "@type": "Product",
            sku: "UB22-BLACK-9",
            gtin13: "4066746000001",
            color: "Black",
            size: "9",
            offers: {
              "@type": "Offer",
              price: 180,
              priceCurrency: "AUD",
              availability: "https://schema.org/InStock",
            },
          },
          {
            "@type": "Product",
            sku: "UB22-BLACK-10",
            gtin13: "4066746000002",
            color: "Black",
            size: "10",
            offers: { "@type": "Offer", price: 180, priceCurrency: "AUD" },
          },
          {
            "@type": "Product",
            sku: "UB22-WHITE-9",
            gtin13: "4066746000003",
            color: "White",
            size: "9",
            offers: { "@type": "Offer", price: 180, priceCurrency: "AUD" },
          },
          {
            "@type": "Product",
            sku: "UB22-WHITE-10",
            gtin13: "4066746000004",
            color: "White",
            size: "10",
            offers: { "@type": "Offer", price: 190, priceCurrency: "AUD" },
          },
        ],
      },
    ];

    it("emits one variant per hasVariant child with color and size axis values", () => {
      const facts = parseJsonLd(adidasLikeBlocks).facts;
      const colors = facts.filter((f) => /^variants\[\d+\]\.option\.color$/.test(f.rawKey));
      const sizes = facts.filter((f) => /^variants\[\d+\]\.option\.size$/.test(f.rawKey));
      expect(colors.length).toBe(4);
      expect(sizes.length).toBe(4);
      const sizeValues = sizes.map((f) => String(f.extractedValue));
      const colorValues = colors.map((f) => String(f.extractedValue));
      expect(sizeValues).toEqual(expect.arrayContaining(["9", "10", "9", "10"]));
      expect(colorValues).toEqual(expect.arrayContaining(["Black", "Black", "White", "White"]));
    });

    it("emits per-variant SKU from hasVariant children", () => {
      const facts = parseJsonLd(adidasLikeBlocks).facts;
      const skus = facts
        .filter((f) => /^variants\[\d+\]\.sku$/.test(f.rawKey))
        .map((f) => String(f.extractedValue));
      expect(skus).toEqual(
        expect.arrayContaining(["UB22-BLACK-9", "UB22-BLACK-10", "UB22-WHITE-9", "UB22-WHITE-10"])
      );
    });

    it("emits per-variant GTIN from hasVariant children", () => {
      const facts = parseJsonLd(adidasLikeBlocks).facts;
      const gtins = facts
        .filter((f) => /^variants\[\d+\]\.gtin$/.test(f.rawKey))
        .map((f) => String(f.extractedValue));
      expect(gtins).toEqual(
        expect.arrayContaining([
          "4066746000001",
          "4066746000002",
          "4066746000003",
          "4066746000004",
        ])
      );
    });

    it("emits per-variant price from hasVariant child offers", () => {
      const facts = parseJsonLd(adidasLikeBlocks).facts;
      const prices = facts
        .filter((f) => /^variants\[\d+\]\.price$/.test(f.rawKey))
        .map((f) => Number(f.extractedValue));
      // Three variants at 180, one at 190
      expect(prices.filter((p) => p === 180).length).toBe(3);
      expect(prices.filter((p) => p === 190).length).toBe(1);
    });

    it("emits top-level brand and title from the ProductGroup wrapper", () => {
      const facts = parseJsonLd(adidasLikeBlocks).facts;
      expect(facts.find((f) => f.rawKey === "title")?.extractedValue).toBe("Ultraboost 22");
      expect(facts.find((f) => f.rawKey === "brand")?.extractedValue).toBe("Adidas");
    });
  });

  describe("standard schema.org Product fields", () => {
    const richBlocks: Record<string, unknown>[] = [
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Acme Widget Pro",
        sku: "ACM-WID-PRO-001",
        gtin13: "0012345678905",
        gtin12: "012345678905",
        gtin8: "12345670",
        gtin14: "10012345678902",
        color: "Midnight Blue",
        material: "Anodized Aluminum",
        weight: "0.42 kg",
        audience: { "@type": "PeopleAudience", suggestedGender: "Unisex" },
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: "4.6",
          reviewCount: 1284,
        },
        additionalProperty: [
          { "@type": "PropertyValue", name: "Battery Life", value: "12 hours" },
          { "@type": "PropertyValue", name: "Water Resistance", value: "IP68" },
          { "@type": "PropertyValue", name: "Warranty", value: "2 years" },
        ],
        offers: { "@type": "Offer", price: 249, priceCurrency: "AUD" },
      },
    ];

    it("emits product.sku as a fact", () => {
      const facts = parseJsonLd(richBlocks).facts;
      expect(facts.find((f) => f.rawKey === "sku")?.extractedValue).toBe("ACM-WID-PRO-001");
    });

    it("emits a gtin fact preferring gtin13 with subtype in sourcePointer", () => {
      const facts = parseJsonLd(richBlocks).facts;
      const gtin = facts.find((f) => f.rawKey === "gtin");
      expect(gtin?.extractedValue).toBe("0012345678905");
      expect(gtin?.sourcePointer).toContain("gtin13");
    });

    it("emits color, material, weight as canonical facts", () => {
      const facts = parseJsonLd(richBlocks).facts;
      expect(facts.find((f) => f.rawKey === "color")?.extractedValue).toBe("Midnight Blue");
      expect(facts.find((f) => f.rawKey === "material")?.extractedValue).toBe("Anodized Aluminum");
      expect(facts.find((f) => f.rawKey === "weight")?.extractedValue).toBe("0.42 kg");
    });

    it("emits audience.suggestedGender as gender fact", () => {
      const facts = parseJsonLd(richBlocks).facts;
      expect(facts.find((f) => f.rawKey === "gender")?.extractedValue).toBe("Unisex");
    });

    it("emits aggregateRating.ratingValue as rating fact", () => {
      const facts = parseJsonLd(richBlocks).facts;
      const rating = facts.find((f) => f.rawKey === "rating");
      expect(Number(rating?.extractedValue)).toBeCloseTo(4.6, 2);
    });

    it("emits one fact per additionalProperty entry, keyed by its name", () => {
      const facts = parseJsonLd(richBlocks).facts;
      const byKey = (k: string) => facts.find((f) => f.rawKey === k);
      expect(byKey("battery_life")?.extractedValue).toBe("12 hours");
      expect(byKey("water_resistance")?.extractedValue).toBe("IP68");
      expect(byKey("warranty")?.extractedValue).toBe("2 years");
    });
  });

  describe("breadcrumb leaf handling", () => {
    it("drops the last breadcrumb item (the product itself) before joining", () => {
      const blocks: Record<string, unknown>[] = [
        {
          "@type": "Product",
          name: "iPhone 15 Pro Max 256GB",
          offers: { price: 2199, priceCurrency: "AUD" },
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { name: "Home" },
            { name: "Electronics" },
            { name: "Phones" },
            { name: "iPhone 15 Pro Max 256GB" },
          ],
        },
      ];
      const cat = parseJsonLd(blocks).facts.find((f) => f.rawKey === "productType");
      expect(cat?.extractedValue).toBe("Home/Electronics/Phones");
      expect(String(cat?.extractedValue)).not.toContain("iPhone");
    });

    it("keeps a single-item breadcrumb intact (no leaf to drop)", () => {
      const blocks: Record<string, unknown>[] = [
        { "@type": "Product", name: "X" },
        { "@type": "BreadcrumbList", itemListElement: [{ name: "Home" }] },
      ];
      const cat = parseJsonLd(blocks).facts.find((f) => f.rawKey === "productType");
      expect(cat?.extractedValue).toBe("Home");
    });
  });

  describe("TLD-aware offer picking", () => {
    const multiCurrencyBlocks: Record<string, unknown>[] = [
      {
        "@type": "Product",
        name: "Multi-region SKU",
        offers: [
          { price: 199, priceCurrency: "USD" },
          { price: 299, priceCurrency: "AUD" },
          { price: 14999, priceCurrency: "INR" },
        ],
      },
    ];

    it("picks the AUD offer for a .com.au page", () => {
      const facts = parseJsonLd(multiCurrencyBlocks, {
        pageUrl: "https://example.com.au/product/multi-region",
      }).facts;
      expect(facts.find((f) => f.rawKey === "base_price")?.extractedValue).toBe(299);
      expect(facts.find((f) => f.rawKey === "currency")?.extractedValue).toBe("AUD");
    });

    it("picks the INR offer for a .in page", () => {
      const facts = parseJsonLd(multiCurrencyBlocks, {
        pageUrl: "https://example.in/product/multi-region",
      }).facts;
      expect(facts.find((f) => f.rawKey === "base_price")?.extractedValue).toBe(14999);
      expect(facts.find((f) => f.rawKey === "currency")?.extractedValue).toBe("INR");
    });

    it("falls back to first offer when no TLD currency match", () => {
      const facts = parseJsonLd(multiCurrencyBlocks, {
        pageUrl: "https://example.de/product/multi-region",
      }).facts;
      expect(facts.find((f) => f.rawKey === "currency")?.extractedValue).toBe("USD");
    });

    it("handles AggregateOffer with nested offers[]", () => {
      const blocks: Record<string, unknown>[] = [
        {
          "@type": "Product",
          name: "Agg",
          offers: {
            "@type": "AggregateOffer",
            offers: [
              { price: 100, priceCurrency: "USD" },
              { price: 150, priceCurrency: "AUD" },
            ],
          },
        },
      ];
      const facts = parseJsonLd(blocks, {
        pageUrl: "https://shop.com.au/p/1",
      }).facts;
      expect(facts.find((f) => f.rawKey === "currency")?.extractedValue).toBe("AUD");
    });
  });
});
