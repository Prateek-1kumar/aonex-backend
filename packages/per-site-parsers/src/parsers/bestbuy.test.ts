import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bestbuyParser } from "./bestbuy.js";

const html = readFileSync(
  join(import.meta.dir, "../fixtures/bestbuy/sample-product.html"),
  "utf-8"
);

describe("bestbuyParser", () => {
  it("declares bestbuy domains", () => {
    expect(bestbuyParser.domains).toEqual(
      expect.arrayContaining(["bestbuy.com", "bestbuy.ca"])
    );
  });

  it("has fingerprint + priority + requiresBrowser=true", () => {
    expect(bestbuyParser.fingerprint).toMatch(/^bestbuy@/);
    expect(bestbuyParser.priority).toBe(100);
    expect(bestbuyParser.requiresBrowser).toBe(true);
  });

  it("extracts sku from URL /site/.../<digits>.p pattern", async () => {
    const facts = await bestbuyParser.extract({
      rawHtml: html,
      url: "https://www.bestbuy.com/site/sony-wh-1000xm5/6505727.p?skuId=6505727",
    });
    expect(facts.find((f) => f.rawKey === "sku")?.extractedValue).toBe("6505727");
  });

  it("extracts title + price + currency", async () => {
    const facts = await bestbuyParser.extract({
      rawHtml: html,
      url: "https://www.bestbuy.com/site/x/6505727.p",
    });
    expect(facts.find((f) => f.rawKey === "title")?.extractedValue).toBe(
      "Sony WH-1000XM5 Wireless Noise-Canceling Headphones"
    );
    expect(facts.find((f) => f.rawKey === "base_price")?.extractedValue).toBe(349.99);
    expect(facts.find((f) => f.rawKey === "currency")?.extractedValue).toBe("USD");
  });

  it("extracts model number from .model-number block", async () => {
    const facts = await bestbuyParser.extract({
      rawHtml: html,
      url: "https://bestbuy.com/site/x/123.p",
    });
    expect(facts.find((f) => f.rawKey === "model_number")?.extractedValue).toBe(
      "WH1000XM5/B"
    );
  });

  it("extracts spec table rows", async () => {
    const facts = await bestbuyParser.extract({
      rawHtml: html,
      url: "https://bestbuy.com/site/x/123.p",
    });
    expect(facts.find((f) => f.rawKey === "color")?.extractedValue).toBe("Black");
    expect(facts.find((f) => f.rawKey === "battery_life")?.extractedValue).toBe("30 hours");
    expect(facts.find((f) => f.rawKey === "connectivity")?.extractedValue).toBe("Bluetooth 5.2");
  });

  it("extracts images from primary + thumbnails", async () => {
    const facts = await bestbuyParser.extract({
      rawHtml: html,
      url: "https://bestbuy.com/site/x/123.p",
    });
    const imgFact = facts.find((f) => f.rawKey === "images");
    expect(Array.isArray(imgFact?.extractedValue)).toBe(true);
    expect((imgFact?.extractedValue as { url: string }[]).length).toBeGreaterThanOrEqual(1);
  });

  it("returns minimal facts for empty HTML", async () => {
    const facts = await bestbuyParser.extract({
      rawHtml: "<html></html>",
      url: "https://www.bestbuy.com/site/foo/6505727.p",
    });
    expect(facts.find((f) => f.rawKey === "sku")?.extractedValue).toBe("6505727");
    expect(facts.find((f) => f.rawKey === "title")).toBeUndefined();
  });
});
