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
});
