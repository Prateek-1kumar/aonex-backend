import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walmartParser } from "./walmart.js";

const html = readFileSync(join(import.meta.dir, "../fixtures/walmart/sample-product.html"), "utf-8");

describe("walmartParser", () => {
  it("declares walmart.com", () => {
    expect(walmartParser.domains).toContain("walmart.com");
  });

  it("has fingerprint + priority + requiresBrowser=true", () => {
    expect(walmartParser.fingerprint).toMatch(/^walmart@/);
    expect(walmartParser.priority).toBe(100);
    expect(walmartParser.requiresBrowser).toBe(true);
  });

  it("extracts product_id from /ip/<slug>/<id> URL pattern", async () => {
    const facts = await walmartParser.extract({
      rawHtml: html,
      url: "https://www.walmart.com/ip/Aonami-Cordless-Drill/987654321",
    });
    expect(facts.find((f) => f.rawKey === "product_id")?.extractedValue).toBe("987654321");
  });

  it("extracts title + brand + price + gtin + model from __NEXT_DATA__ (preferred path)", async () => {
    const facts = await walmartParser.extract({ rawHtml: html, url: "https://www.walmart.com/ip/x/123" });
    expect(facts.find((f) => f.rawKey === "title")?.extractedValue).toBe("Aonami Cordless Drill 18V");
    expect(facts.find((f) => f.rawKey === "brand")?.extractedValue).toBe("Aonami");
    expect(facts.find((f) => f.rawKey === "base_price")?.extractedValue).toBe(129.99);
    expect(facts.find((f) => f.rawKey === "currency")?.extractedValue).toBe("USD");
    expect(facts.find((f) => f.rawKey === "gtin")?.extractedValue).toBe("8901234567890");
    expect(facts.find((f) => f.rawKey === "model_number")?.extractedValue).toBe("AON-DRILL-1");
  });

  it("falls back to DOM selectors when __NEXT_DATA__ is missing", async () => {
    const noNextData = html.replace(/<script id="__NEXT_DATA__".*?<\/script>/s, "");
    const facts = await walmartParser.extract({ rawHtml: noNextData, url: "https://walmart.com/ip/x/123" });
    expect(facts.find((f) => f.rawKey === "title")?.extractedValue).toBe("Aonami Cordless Drill 18V");
    expect(facts.find((f) => f.rawKey === "base_price")?.extractedValue).toBe(129.99);
  });

  it("extracts spec table rows when present", async () => {
    const facts = await walmartParser.extract({ rawHtml: html, url: "https://walmart.com/ip/x/123" });
    expect(facts.find((f) => f.rawKey === "voltage")?.extractedValue).toBe("18V");
    expect(facts.find((f) => f.rawKey === "battery_type")?.extractedValue).toBe("Lithium-ion");
  });

  it("returns empty for non-Walmart HTML without __NEXT_DATA__", async () => {
    const facts = await walmartParser.extract({
      rawHtml: "<html></html>",
      url: "https://walmart.com/no-id-here",
    });
    expect(facts.find((f) => f.rawKey === "title")).toBeUndefined();
  });
});
