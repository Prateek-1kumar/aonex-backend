import { describe, expect, it } from "bun:test";
import { extractBreadcrumbFromDom } from "./breadcrumb.js";

describe("extractBreadcrumbFromDom", () => {
  it("extracts breadcrumb chain and drops last item (product name), depth-weighted confidence", () => {
    const html = `<html><body>
      <nav class="breadcrumb">
        <a>Home</a> / <a>Electronics</a> / <a>Televisions</a> / <span>Aonami Vision 55</span>
      </nav>
    </body></html>`;
    const fact = extractBreadcrumbFromDom(html);
    expect(fact).not.toBeNull();
    expect(fact!.rawKey).toBe("category_path");
    expect(fact!.extractedValue).toBe("home/electronics/televisions");
    // chain length = 3, confidence = 0.50 + 0.10 * min(3, 4) = 0.80
    expect(fact!.confidence).toBeCloseTo(0.80);
    expect(fact!.sourcePointer).toBe("dom_heuristic:breadcrumb");
    expect(fact!.extractionMethod).toBe("inferred");
  });

  it("returns null when no breadcrumb is present", () => {
    const html = `<html><body><p>No breadcrumb here</p></body></html>`;
    const fact = extractBreadcrumbFromDom(html);
    expect(fact).toBeNull();
  });

  it("returns null when breadcrumb has only one item (nothing to drop)", () => {
    const html = `<html><body>
      <ol class="breadcrumb">
        <li>Home</li>
      </ol>
    </body></html>`;
    const fact = extractBreadcrumbFromDom(html);
    expect(fact).toBeNull();
  });
});
