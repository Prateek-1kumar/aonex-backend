import { describe, it, expect } from "bun:test";
import { parseNuxt } from "./nuxt.js";

const FULL_HTML = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<script>
window.__NUXT__={
  "payload": {
    "product": {
      "name": "Aonami Pro Drill",
      "brand": "Aonami",
      "price": 199.99,
      "gtin": "1234567890123",
      "mpn": "AON-DRILL-1",
      "description": "Professional grade drill",
      "attributes": {
        "color": "red",
        "weight": "2kg"
      }
    }
  }
};
</script>
</body>
</html>`;

const EMPTY_HTML = `<!DOCTYPE html>
<html><body><p>No nuxt here</p></body></html>`;

describe("parseNuxt", () => {
  it("happy path — extracts facts from window.__NUXT__ payload", () => {
    const result = parseNuxt(FULL_HTML);
    expect(result.kind).toBe("nuxt");
    expect(result.baselineConfidence).toBe(0.85);
    expect(result.facts.length).toBeGreaterThanOrEqual(5);

    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Aonami Pro Drill");
    expect(byKey("brand")?.extractedValue).toBe("Aonami");
    expect(byKey("base_price")?.extractedValue).toBe(199.99);
    expect(byKey("gtin")?.extractedValue).toBe("1234567890123");
    expect(byKey("model_number")?.extractedValue).toBe("AON-DRILL-1");
    expect(byKey("description")?.extractedValue).toBe("Professional grade drill");
  });

  it("flattens product.attributes into individual facts", () => {
    const result = parseNuxt(FULL_HTML);
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("color")?.extractedValue).toBe("red");
    expect(byKey("weight")?.extractedValue).toBe("2kg");
    const colorFact = byKey("color");
    expect(colorFact?.sourcePointer).toBe("nuxt:product.attributes.color");
  });

  it("all facts use extractionMethod=direct", () => {
    const result = parseNuxt(FULL_HTML);
    for (const f of result.facts) {
      expect(f.extractionMethod).toBe("direct");
    }
  });

  it("empty path — no __NUXT__ in HTML returns empty facts", () => {
    const result = parseNuxt(EMPTY_HTML);
    expect(result.kind).toBe("nuxt");
    expect(result.facts).toEqual([]);
  });

  it("handles malformed JSON gracefully", () => {
    const badHtml = `<script>window.__NUXT__={broken json</script>`;
    const result = parseNuxt(badHtml);
    expect(result.kind).toBe("nuxt");
    expect(result.facts).toEqual([]);
  });

  it("walks alternate payload paths: payload.state.product", () => {
    const html = `<script>window.__NUXT__={"payload":{"state":{"product":{"title":"State Drill","price":99}}}}</script>`;
    const result = parseNuxt(html);
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("State Drill");
    expect(byKey("base_price")?.extractedValue).toBe(99);
  });
});
