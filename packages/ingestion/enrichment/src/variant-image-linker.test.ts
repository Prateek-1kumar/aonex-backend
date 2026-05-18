import { describe, it, expect } from "bun:test";
import { linkVariantsToImages } from "./variant-image-linker.js";

describe("linkVariantsToImages", () => {
  it("uses JSON-LD direct map when available", () => {
    const linked = linkVariantsToImages(
      [{ sku: "RED-M", option_values: { Color: "Red", Size: "M" } }],
      [{ url: "https://x.com/a.jpg", alt: null }],
      { "RED-M": ["https://x.com/red.jpg"] },
      undefined
    );
    expect(linked[0]?.image_urls).toEqual(["https://x.com/red.jpg"]);
  });

  it("uses DOM proximity map when JSON-LD missing", () => {
    const linked = linkVariantsToImages(
      [{ sku: null, option_values: { Color: "Red" } }],
      [{ url: "https://x.com/a.jpg", alt: null }],
      undefined,
      { '{"Color":"Red"}': "https://x.com/red.jpg" }
    );
    expect(linked[0]?.image_urls).toEqual(["https://x.com/red.jpg"]);
  });

  it("matches by color name in image alt", () => {
    const linked = linkVariantsToImages(
      [{ sku: null, option_values: { Color: "Crimson Red" } }],
      [
        { url: "https://x.com/a.jpg", alt: "Crimson Red shoe" },
        { url: "https://x.com/b.jpg", alt: "Blue shoe" }
      ]
    );
    expect(linked[0]?.image_urls).toEqual(["https://x.com/a.jpg"]);
  });

  it("matches by color name in image URL path", () => {
    const linked = linkVariantsToImages(
      [{ sku: null, option_values: { Color: "Forest Green" } }],
      [
        { url: "https://x.com/forest-green-shoe.jpg", alt: null },
        { url: "https://x.com/blue-shoe.jpg", alt: null }
      ]
    );
    expect(linked[0]?.image_urls).toEqual(["https://x.com/forest-green-shoe.jpg"]);
  });

  it("returns empty image_urls when no link found", () => {
    const linked = linkVariantsToImages(
      [{ sku: null, option_values: { Size: "L" } }],
      [{ url: "https://x.com/a.jpg", alt: null }]
    );
    expect(linked[0]?.image_urls).toEqual([]);
  });

  it("returns empty image_urls when multiple matches (ambiguous)", () => {
    const linked = linkVariantsToImages(
      [{ sku: null, option_values: { Color: "Red" } }],
      [
        { url: "https://x.com/red1.jpg", alt: "Red front" },
        { url: "https://x.com/red2.jpg", alt: "Red back" }
      ]
    );
    expect(linked[0]?.image_urls).toEqual([]);
  });

  it("preserves all variant fields", () => {
    const linked = linkVariantsToImages(
      [{ sku: "ABC", option_values: { Color: "Red" } }],
      [{ url: "https://x.com/a.jpg", alt: "Red" }]
    );
    expect(linked[0]?.sku).toBe("ABC");
    expect(linked[0]?.option_values).toEqual({ Color: "Red" });
  });
});
