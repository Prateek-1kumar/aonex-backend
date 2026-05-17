import { describe, it, expect } from "bun:test";
import { parseMagento } from "./magento-init.js";

const MAGENTO_HTML = `<!DOCTYPE html>
<html>
<body>
<script type="text/x-magento-init">
{
  "[data-role='priceBox']": {
    "Magento_Catalog/js/price-box": {
      "priceConfig": {
        "productId": "42",
        "priceFormat": { "decimalSymbol": "." },
        "prices": { "finalPrice": { "amount": 199.99 } }
      }
    }
  },
  "#product-info": {
    "Magento_Catalog/product/view": {
      "productName": "Aonami Pro Drill",
      "sku": "AON-DRILL-1",
      "brand": "Aonami"
    }
  }
}
</script>
</body>
</html>`;

const EMPTY_HTML = `<!DOCTYPE html>
<html><body><p>No magento here</p></body></html>`;

const MALFORMED_HTML = `<!DOCTYPE html>
<html><body>
<script type="text/x-magento-init">
{ broken json
</script>
</body></html>`;

describe("parseMagento", () => {
  it("happy path — extracts price, title, brand from x-magento-init", () => {
    const result = parseMagento(MAGENTO_HTML);
    expect(result.kind).toBe("magento");
    expect(result.baselineConfidence).toBe(0.80);
    expect(result.facts.length).toBeGreaterThanOrEqual(3);

    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("base_price")?.extractedValue).toBe(199.99);
    expect(byKey("title")?.extractedValue).toBe("Aonami Pro Drill");
    expect(byKey("brand")?.extractedValue).toBe("Aonami");
  });

  it("sourcePointers reference magento prefix", () => {
    const result = parseMagento(MAGENTO_HTML);
    for (const f of result.facts) {
      expect(f.sourcePointer).toMatch(/^magento:/);
    }
  });

  it("all facts use extractionMethod=direct", () => {
    const result = parseMagento(MAGENTO_HTML);
    for (const f of result.facts) {
      expect(f.extractionMethod).toBe("direct");
    }
  });

  it("empty path — no x-magento-init returns empty facts", () => {
    const result = parseMagento(EMPTY_HTML);
    expect(result.kind).toBe("magento");
    expect(result.facts).toEqual([]);
  });

  it("handles malformed JSON gracefully", () => {
    const result = parseMagento(MALFORMED_HTML);
    expect(result.kind).toBe("magento");
    expect(result.facts).toEqual([]);
  });

  it("extracts sku as model_number when present in product/view block", () => {
    const result = parseMagento(MAGENTO_HTML);
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    // sku in Magento Catalog/product/view → model_number
    expect(byKey("model_number")?.extractedValue).toBe("AON-DRILL-1");
  });
});
