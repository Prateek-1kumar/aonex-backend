import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cromaParser } from "./croma.js";

const html = readFileSync(join(import.meta.dir, "../fixtures/croma/sample-product.html"), "utf-8");

describe("cromaParser", () => {
  it("declares croma.com", () => {
    expect(cromaParser.domains).toContain("croma.com");
  });

  it("has fingerprint + priority + requiresBrowser=false (SSR)", () => {
    expect(cromaParser.fingerprint).toMatch(/^croma@/);
    expect(cromaParser.priority).toBe(100);
    expect(cromaParser.requiresBrowser).toBe(false);
  });

  it("extracts sku from URL /p/<sku> pattern", async () => {
    const facts = await cromaParser.extract({
      rawHtml: html,
      url: "https://www.croma.com/sony-wh-1000xm5-bluetooth-headphones-black-/p/262844",
    });
    expect(facts.find((f) => f.rawKey === "sku")?.extractedValue).toBe("262844");
  });

  it("extracts title + brand + price + currency + gtin from JSON-LD", async () => {
    const facts = await cromaParser.extract({
      rawHtml: html,
      url: "https://www.croma.com/sony-headphones/p/262844",
    });
    expect(facts.find((f) => f.rawKey === "title")?.extractedValue).toBe("Sony WH-1000XM5 Bluetooth Headphones (Black)");
    expect(facts.find((f) => f.rawKey === "brand")?.extractedValue).toBe("Sony");
    expect(facts.find((f) => f.rawKey === "base_price")?.extractedValue).toBe(29990);
    expect(facts.find((f) => f.rawKey === "currency")?.extractedValue).toBe("INR");
    expect(facts.find((f) => f.rawKey === "gtin")?.extractedValue).toBe("4548736134331");
  });

  it("falls back to DOM selectors when JSON-LD is absent", async () => {
    const noJsonLd = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
    const facts = await cromaParser.extract({
      rawHtml: noJsonLd,
      url: "https://www.croma.com/x/p/262844",
    });
    expect(facts.find((f) => f.rawKey === "title")?.extractedValue).toContain("Sony WH-1000XM5");
    expect(facts.find((f) => f.rawKey === "base_price")?.extractedValue).toBe(29990);
    expect(facts.find((f) => f.rawKey === "currency")?.extractedValue).toBe("INR");
    expect(facts.find((f) => f.rawKey === "brand")?.extractedValue).toBe("Sony");
  });

  it("extracts spec list rows", async () => {
    const facts = await cromaParser.extract({ rawHtml: html, url: "https://croma.com/x/p/262844" });
    expect(facts.find((f) => f.rawKey === "color")?.extractedValue).toBe("Black");
    expect(facts.find((f) => f.rawKey === "connectivity")?.extractedValue).toBe("Bluetooth 5.2");
    expect(facts.find((f) => f.rawKey === "battery_life")?.extractedValue).toBe("30 hours");
    expect(facts.find((f) => f.rawKey === "warranty")?.extractedValue).toContain("1 year");
  });

  it("extracts images from product-image gallery", async () => {
    const facts = await cromaParser.extract({ rawHtml: html, url: "https://croma.com/x/p/262844" });
    const imgFact = facts.find((f) => f.rawKey === "images");
    expect(Array.isArray(imgFact?.extractedValue)).toBe(true);
    expect((imgFact?.extractedValue as { url: string }[]).length).toBe(2);
  });

  it("returns sku only when HTML is empty", async () => {
    const facts = await cromaParser.extract({
      rawHtml: "<html></html>",
      url: "https://www.croma.com/foo/p/262844",
    });
    expect(facts.find((f) => f.rawKey === "sku")?.extractedValue).toBe("262844");
    expect(facts.find((f) => f.rawKey === "title")).toBeUndefined();
  });
});
