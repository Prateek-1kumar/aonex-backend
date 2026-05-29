import { test, expect } from "bun:test";
import { cromaParser } from "./croma.js";

const GRAPH_HTML = `<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "BreadcrumbList" },
    { "@type": ["Product"], name: "Google Pixel 10 5G", brand: { name: "Google" },
      offers: { "@type": "Offer", price: "79999", priceCurrency: "INR" } },
  ],
})}</script>`;

test("extracts brand and price from @graph-wrapped Product", async () => {
  const facts = await cromaParser.extract({ rawHtml: GRAPH_HTML, url: "https://croma.com/x/p/123" });
  const byKey = Object.fromEntries(facts.map((f) => [f.rawKey, f.extractedValue]));
  expect(byKey.brand).toBe("Google");
  expect(byKey.base_price).toBe(79999);
  expect(byKey.currency).toBe("INR");
});
