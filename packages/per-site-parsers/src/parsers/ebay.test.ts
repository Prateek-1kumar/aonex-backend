import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ebayParser } from "./ebay.js";

const html = readFileSync(join(import.meta.dir, "../fixtures/ebay/sample-product.html"), "utf-8");

describe("ebayParser", () => {
  it("declares ebay domains", () => {
    expect(ebayParser.domains).toEqual(
      expect.arrayContaining(["ebay.com", "ebay.co.uk", "ebay.de"])
    );
  });

  it("has fingerprint + priority + requiresBrowser=false", () => {
    expect(ebayParser.fingerprint).toMatch(/^ebay@/);
    expect(ebayParser.priority).toBe(100);
    expect(ebayParser.requiresBrowser).toBe(false);
  });

  it("extracts item_id from /itm/<id> URL pattern", async () => {
    const facts = await ebayParser.extract({
      rawHtml: html,
      url: "https://www.ebay.com/itm/123456789012"
    });
    expect(facts.find((f) => f.rawKey === "item_id")?.extractedValue).toBe("123456789012");
  });

  it("extracts item_id from /itm/<slug>/<id> URL pattern", async () => {
    const facts = await ebayParser.extract({
      rawHtml: html,
      url: "https://www.ebay.com/itm/Aonami-Vintage-Camera/123456789012"
    });
    expect(facts.find((f) => f.rawKey === "item_id")?.extractedValue).toBe("123456789012");
  });

  it("extracts title and price from fixture", async () => {
    const facts = await ebayParser.extract({ rawHtml: html, url: "https://www.ebay.com/itm/x/123456789012" });
    expect(facts.find((f) => f.rawKey === "title")?.extractedValue).toBe("Aonami Vintage 35mm SLR Camera - Excellent Condition");
    expect(facts.find((f) => f.rawKey === "base_price")?.extractedValue).toBe(249.99);
    expect(facts.find((f) => f.rawKey === "currency")?.extractedValue).toBe("USD");
  });

  it("extracts item specifics (brand, model, condition) as fact rows", async () => {
    const facts = await ebayParser.extract({ rawHtml: html, url: "https://www.ebay.com/itm/123" });
    expect(facts.find((f) => f.rawKey === "brand")?.extractedValue).toBe("Aonami");
    expect(facts.find((f) => f.rawKey === "model")?.extractedValue).toBe("AON-SLR-35");
    expect(facts.find((f) => f.rawKey === "condition")?.extractedValue).toBe("Used - Excellent");
  });

  it("extracts images from carousel", async () => {
    const facts = await ebayParser.extract({ rawHtml: html, url: "https://www.ebay.com/itm/123" });
    const imgFact = facts.find((f) => f.rawKey === "images");
    expect(Array.isArray(imgFact?.extractedValue)).toBe(true);
    expect((imgFact?.extractedValue as { url: string }[]).length).toBeGreaterThanOrEqual(1);
  });

  it("returns minimal facts for empty HTML (only URL-derived item_id)", async () => {
    const facts = await ebayParser.extract({
      rawHtml: "<html></html>",
      url: "https://www.ebay.com/itm/999888777666"
    });
    expect(facts.find((f) => f.rawKey === "item_id")?.extractedValue).toBe("999888777666");
    expect(facts.find((f) => f.rawKey === "title")).toBeUndefined();
  });
});
