import { test, expect } from "bun:test";
import { parseJsonLd } from "./json-ld.js";

test("parseJsonLd finds Product even when @type is an array", () => {
  const out = parseJsonLd([
    {
      "@type": ["Product", "Thing"],
      name: "Pixel 10",
      offers: { price: "79999", priceCurrency: "INR" },
    },
  ]);
  const byKey = Object.fromEntries(
    out.facts.map((f) => [f.rawKey, f.extractedValue])
  );
  expect(byKey.title).toBe("Pixel 10");
  expect(byKey.base_price).toBe(79999);
});
