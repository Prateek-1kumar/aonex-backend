import { describe, expect, it } from "bun:test";
import { extractPriceFromDom } from "./price.js";

describe("extractPriceFromDom", () => {
  it("itemprop=price wins over class-based candidate", () => {
    const html = `
      <html>
        <body>
          <span itemprop="price" content="29.99">$29.99</span>
          <div class="product-price">$45.00</div>
        </body>
      </html>
    `;
    const result = extractPriceFromDom(html);
    expect(result).not.toBeNull();
    expect(result!.extractedValue).toBe(29.99);
    expect(result!.confidence).toBe(0.90);
    expect(result!.sourcePointer).toContain('itemprop="price"');
    expect(result!.extractionMethod).toBe("inferred");
    expect(result!.rawKey).toBe("base_price");
  });

  it("returns null for empty HTML", () => {
    expect(extractPriceFromDom("")).toBeNull();
    expect(extractPriceFromDom("<html><body></body></html>")).toBeNull();
  });

  it("picks smallest value among class-based candidates to avoid shipping/tax pollution", () => {
    const html = `
      <html>
        <body>
          <span class="product-price">$12.99</span>
          <span class="shipping-cost">$5.99</span>
          <span class="total-amount">$18.98</span>
        </body>
      </html>
    `;
    const result = extractPriceFromDom(html);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.65);
    // All 3 are at same confidence (0.65), smallest value wins
    expect(result!.extractedValue).toBe(5.99);
  });
});
