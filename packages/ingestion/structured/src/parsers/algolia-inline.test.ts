import { describe, it, expect } from "bun:test";
import { parseAlgolia } from "./algolia-inline.js";

const ALGOLIA_DATA_HTML = `<!DOCTYPE html>
<html>
<body>
<script type="application/json" id="__ALGOLIA_DATA__">
{
  "hits": [
    {
      "objectID": "prod-1",
      "name": "Aonami Pro Drill",
      "brand": "Aonami",
      "price": 199.99,
      "gtin": "1234567890123"
    }
  ]
}
</script>
</body>
</html>`;

const ALGOLIA_SCRIPT_TAG_HTML = `<!DOCTYPE html>
<html>
<body>
<script id="__ALGOLIA_DATA__">
{
  "hits": [
    {
      "objectID": "prod-2",
      "title": "Cordless Driver",
      "vendor": "ToolCo",
      "price": 79.99
    }
  ]
}
</script>
</body>
</html>`;

const NO_ALGOLIA_HTML = `<!DOCTYPE html>
<html><body><p>No algolia here</p></body></html>`;

const MALFORMED_ALGOLIA_HTML = `<!DOCTYPE html>
<html>
<body>
<script type="application/json" id="__ALGOLIA_DATA__">
{ broken json
</script>
</body>
</html>`;

describe("parseAlgolia", () => {
  it("happy path — extracts facts from __ALGOLIA_DATA__ script", () => {
    const result = parseAlgolia(ALGOLIA_DATA_HTML);
    expect(result.kind).toBe("algolia");
    expect(result.baselineConfidence).toBe(0.75);
    expect(result.facts.length).toBeGreaterThanOrEqual(3);

    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Aonami Pro Drill");
    expect(byKey("brand")?.extractedValue).toBe("Aonami");
    expect(byKey("base_price")?.extractedValue).toBe(199.99);
    expect(byKey("gtin")?.extractedValue).toBe("1234567890123");
  });

  it("works with plain <script id=__ALGOLIA_DATA__> (no type attr)", () => {
    const result = parseAlgolia(ALGOLIA_SCRIPT_TAG_HTML);
    expect(result.kind).toBe("algolia");
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Cordless Driver");
    expect(byKey("brand")?.extractedValue).toBe("ToolCo");
    expect(byKey("base_price")?.extractedValue).toBe(79.99);
  });

  it("all facts use extractionMethod=direct", () => {
    const result = parseAlgolia(ALGOLIA_DATA_HTML);
    for (const f of result.facts) {
      expect(f.extractionMethod).toBe("direct");
    }
  });

  it("no Algolia data returns empty facts", () => {
    const result = parseAlgolia(NO_ALGOLIA_HTML);
    expect(result.kind).toBe("algolia");
    expect(result.facts).toEqual([]);
  });

  it("handles malformed JSON gracefully", () => {
    const result = parseAlgolia(MALFORMED_ALGOLIA_HTML);
    expect(result.kind).toBe("algolia");
    expect(result.facts).toEqual([]);
  });

  it("sourcePointers reference algolia prefix", () => {
    const result = parseAlgolia(ALGOLIA_DATA_HTML);
    for (const f of result.facts) {
      expect(f.sourcePointer).toMatch(/^algolia:/);
    }
  });
});
