import { describe, it, expect } from "bun:test";
import { parseMicrodata } from "./microdata.js";

describe("parseMicrodata", () => {
  it("extracts itemprop name and price", () => {
    const html =
      '<div itemtype="https://schema.org/Product">' +
      '<span itemprop="name">Cool Shirt</span>' +
      '<meta itemprop="price" content="49.99">' +
      '<meta itemprop="priceCurrency" content="USD">' +
      "</div>";
    const out = parseMicrodata(html);
    const get = (k: string) => out.facts.find((f) => f.rawKey === k)?.extractedValue;
    expect(get("title")).toBe("Cool Shirt");
    expect(get("base_price")).toBe(49.99);
    expect(get("currency")).toBe("USD");
  });
});
