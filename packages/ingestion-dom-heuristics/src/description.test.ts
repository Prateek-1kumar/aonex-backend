import { describe, expect, it } from "bun:test";
import { extractDescriptionFromDom } from "./description.js";

describe("extractDescriptionFromDom", () => {
  it("og:description wins over meta name=description and class-based", () => {
    const html = `
      <html>
        <head>
          <meta property="og:description" content="The best premium widget for industrial use." />
          <meta name="description" content="Buy our widget online at the best price." />
        </head>
        <body>
          <div class="product-description">This widget is available in multiple sizes and colors for industrial applications.</div>
        </body>
      </html>
    `;
    const result = extractDescriptionFromDom(html);
    expect(result).not.toBeNull();
    expect(result!.extractedValue).toBe(
      "The best premium widget for industrial use."
    );
    expect(result!.confidence).toBe(0.8);
    expect(result!.sourcePointer).toContain('meta[property="og:description"]');
    expect(result!.extractionMethod).toBe("inferred");
    expect(result!.rawKey).toBe("description");
  });

  it("returns null for empty HTML", () => {
    expect(extractDescriptionFromDom("")).toBeNull();
    expect(extractDescriptionFromDom("<html><body></body></html>")).toBeNull();
  });
});
