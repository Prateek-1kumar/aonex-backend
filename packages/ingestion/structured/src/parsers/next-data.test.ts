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
});
