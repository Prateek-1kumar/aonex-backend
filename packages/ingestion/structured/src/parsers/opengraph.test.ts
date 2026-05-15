import { describe, it, expect } from "bun:test";
import { parseOpenGraph } from "./opengraph.js";

describe("parseOpenGraph", () => {
  it("extracts og:title and product:price:*", () => {
    const html =
      '<meta property="og:title" content="My Shirt">' +
      '<meta property="product:price:amount" content="29.99">' +
      '<meta property="product:price:currency" content="USD">';
    const out = parseOpenGraph(html);
    const get = (k: string) => out.facts.find((f) => f.rawKey === k)?.extractedValue;
    expect(get("title")).toBe("My Shirt");
    expect(get("base_price")).toBe(29.99);
    expect(get("currency")).toBe("USD");
  });
});
