import { describe, it, expect } from "bun:test";
import { compressJsonLd } from "./jsonld-compressor.js";

describe("compressJsonLd", () => {
  it("keeps Product blocks", () => {
    const out = compressJsonLd([{ "@type": "Product", name: "X", image: "u" }]);
    expect(out[0]).toMatchObject({ "@type": "Product", name: "X" });
  });

  it("drops non-product top-level blocks", () => {
    const out = compressJsonLd([
      { "@type": "Product", name: "X" },
      { "@type": "BreadcrumbList", itemListElement: [] }
    ]);
    expect(out).toHaveLength(1);
  });

  it("strips verbose review arrays inside Product", () => {
    const out = compressJsonLd([{ "@type": "Product", name: "X", review: [{ body: "long".repeat(2000) }] }]);
    expect(JSON.stringify(out[0])).not.toContain("long");
  });

  it("caps total output at 8KB", () => {
    const huge = { "@type": "Product", name: "X", description: "x".repeat(20000) };
    const out = compressJsonLd([huge]);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(8192);
  });
});
