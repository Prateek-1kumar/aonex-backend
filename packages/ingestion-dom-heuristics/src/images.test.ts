import { describe, expect, it } from "bun:test";
import { extractImagesFromDom } from "./images.js";

describe("extractImagesFromDom", () => {
  it("og:image emits a fact with confidence 0.80", () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.shop/product.jpg">
    </head><body></body></html>`;
    const facts = extractImagesFromDom(html);
    expect(facts.length).toBe(1);
    expect(facts[0]!.rawKey).toBe("image_url");
    expect(facts[0]!.extractedValue).toBe("https://cdn.shop/product.jpg");
    expect(facts[0]!.confidence).toBe(0.80);
    expect(facts[0]!.sourcePointer).toBe("dom_heuristic:og:image");
    expect(facts[0]!.extractionMethod).toBe("inferred");
  });

  it("deduplicates images with the same stem (different size suffixes)", () => {
    const html = `<html><body>
      <img src="https://cdn.shop/p_400x600.jpg">
      <img src="https://cdn.shop/p_800x1200.jpg">
      <img src="https://cdn.shop/other_500x500.jpg">
    </body></html>`;
    const facts = extractImagesFromDom(html);
    // p_400x600 and p_800x1200 share stem cdn.shop/p.jpg -> 1 fact
    // other_500x500 -> 1 fact
    expect(facts.length).toBe(2);
    const urls = facts.map((f) => f.extractedValue);
    // The first of the two p-images wins (they're at same confidence, sorted stably)
    expect(urls).toContain("https://cdn.shop/p_400x600.jpg");
    expect(urls).toContain("https://cdn.shop/other_500x500.jpg");
  });

  it("rejects data: URLs, icons, favicons, and small images", () => {
    const html = `<html><body>
      <img src="data:image/png;base64,abc123">
      <img src="/assets/icon/star.png">
      <img src="/assets/sprite.svg">
      <img src="/favicon.ico">
      <img src="https://shop/product.jpg" width="50" height="50">
      <img src="https://shop/valid.jpg" width="400" height="600">
    </body></html>`;
    const facts = extractImagesFromDom(html);
    expect(facts.length).toBe(1);
    expect(facts[0]!.extractedValue).toBe("https://shop/valid.jpg");
    expect(facts[0]!.confidence).toBe(0.60);
  });
});
