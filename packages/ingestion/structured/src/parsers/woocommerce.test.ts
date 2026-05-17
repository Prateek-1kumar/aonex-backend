import { describe, it, expect } from "bun:test";
import { parseWoocommerce } from "./woocommerce.js";

const WOO_HTML = `<!DOCTYPE html>
<html>
<body class="single-product product-template-default">
<div class="product" data-product_id="123" data-product_sku="AON-DRILL-1">
  <h1 class="product_title">Aonami Pro Drill</h1>
  <span class="price"><span class="woocommerce-Price-amount">$199.99</span></span>
</div>
</body>
</html>`;

const NON_WOO_HTML = `<!DOCTYPE html>
<html>
<body class="page home">
<h1>Welcome to our store</h1>
</body>
</html>`;

const WOO_WITHOUT_PRICE_HTML = `<!DOCTYPE html>
<html>
<body class="single-product product-template-default">
<div class="product" data-product_id="456" data-product_sku="SKU-2">
  <h1 class="product_title">Simple Product</h1>
</div>
</body>
</html>`;

describe("parseWoocommerce", () => {
  it("happy path — extracts title, price, sku from WooCommerce page", () => {
    const result = parseWoocommerce(WOO_HTML);
    expect(result.kind).toBe("woocommerce");
    expect(result.baselineConfidence).toBe(0.75);

    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Aonami Pro Drill");
    expect(byKey("base_price")?.extractedValue).toBe(199.99);
    expect(byKey("model_number")?.extractedValue).toBe("AON-DRILL-1");
  });

  it("all facts use extractionMethod=direct", () => {
    const result = parseWoocommerce(WOO_HTML);
    for (const f of result.facts) {
      expect(f.extractionMethod).toBe("direct");
    }
  });

  it("non-WooCommerce page returns empty facts", () => {
    const result = parseWoocommerce(NON_WOO_HTML);
    expect(result.kind).toBe("woocommerce");
    expect(result.facts).toEqual([]);
  });

  it("still extracts title and sku even without price", () => {
    const result = parseWoocommerce(WOO_WITHOUT_PRICE_HTML);
    expect(result.kind).toBe("woocommerce");
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Simple Product");
    expect(byKey("model_number")?.extractedValue).toBe("SKU-2");
  });

  it("sourcePointers reference woocommerce prefix", () => {
    const result = parseWoocommerce(WOO_HTML);
    for (const f of result.facts) {
      expect(f.sourcePointer).toMatch(/^woocommerce:/);
    }
  });
});
