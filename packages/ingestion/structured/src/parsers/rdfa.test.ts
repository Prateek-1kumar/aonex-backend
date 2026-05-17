import { describe, it, expect } from "bun:test";
import { parseRdfa } from "./rdfa.js";

const RDFA_PRODUCT_HTML = `<!DOCTYPE html>
<html>
<body>
<div typeof="schema:Product">
  <h1 property="schema:name">Aonami Pro Drill</h1>
  <span property="schema:brand">Aonami</span>
  <meta property="schema:gtin13" content="1234567890123" />
  <span property="schema:price" content="199.99">$199.99</span>
  <p property="schema:description">A powerful cordless drill for professionals.</p>
</div>
</body>
</html>`;

const RDFA_UNQUALIFIED_HTML = `<!DOCTYPE html>
<html>
<body>
<div typeof="Product">
  <h1 property="name">Widget Pro</h1>
  <span property="brand">WidgetCo</span>
  <span property="price" content="49.99">$49.99</span>
</div>
</body>
</html>`;

const RDFA_FULL_URI_HTML = `<!DOCTYPE html>
<html>
<body>
<div typeof="http://schema.org/Product">
  <h1 property="name">Budget Gadget</h1>
  <span property="brand">BudgetBrand</span>
</div>
</body>
</html>`;

const NO_RDFA_HTML = `<!DOCTYPE html>
<html>
<body>
<div class="product">
  <h1>Regular Product</h1>
</div>
</body>
</html>`;

const CONTENT_ATTR_HTML = `<!DOCTYPE html>
<html>
<body>
<div typeof="schema:Product">
  <h1 property="schema:name">Content Attr Product</h1>
  <meta property="schema:gtin13" content="9876543210987" />
  <meta property="schema:price" content="299.00" />
</div>
</body>
</html>`;

describe("parseRdfa", () => {
  it("extracts 3+ facts from RDFa Product markup (schema: prefix)", () => {
    const result = parseRdfa(RDFA_PRODUCT_HTML);
    expect(result.kind).toBe("rdfa");
    expect(result.baselineConfidence).toBe(0.80);
    expect(result.facts.length).toBeGreaterThanOrEqual(3);

    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Aonami Pro Drill");
    expect(byKey("brand")?.extractedValue).toBe("Aonami");
    expect(byKey("gtin")?.extractedValue).toBe("1234567890123");
    expect(byKey("base_price")?.extractedValue).toBe(199.99);
  });

  it("extracts facts from unqualified typeof=Product markup", () => {
    const result = parseRdfa(RDFA_UNQUALIFIED_HTML);
    expect(result.kind).toBe("rdfa");
    expect(result.facts.length).toBeGreaterThanOrEqual(2);
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Widget Pro");
    expect(byKey("brand")?.extractedValue).toBe("WidgetCo");
  });

  it("extracts facts from full URI typeof markup", () => {
    const result = parseRdfa(RDFA_FULL_URI_HTML);
    expect(result.kind).toBe("rdfa");
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    expect(byKey("title")?.extractedValue).toBe("Budget Gadget");
  });

  it("returns empty facts when no RDFa Product markup is found", () => {
    const result = parseRdfa(NO_RDFA_HTML);
    expect(result.kind).toBe("rdfa");
    expect(result.facts).toEqual([]);
  });

  it("uses content= attribute value over element text when both present", () => {
    const result = parseRdfa(CONTENT_ATTR_HTML);
    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    // meta elements have content= attribute; should get the exact value from content
    expect(byKey("gtin")?.extractedValue).toBe("9876543210987");
    expect(byKey("base_price")?.extractedValue).toBe(299.0);
  });

  it("all emitted facts use extractionMethod=direct", () => {
    const result = parseRdfa(RDFA_PRODUCT_HTML);
    for (const f of result.facts) {
      expect(f.extractionMethod).toBe("direct");
    }
  });

  it("sourcePointers reference rdfa prefix", () => {
    const result = parseRdfa(RDFA_PRODUCT_HTML);
    for (const f of result.facts) {
      expect(f.sourcePointer).toMatch(/^rdfa:/);
    }
  });
});
