import { describe, expect, it } from "bun:test";
import { extractTitleFromDom } from "./title.js";

describe("extractTitleFromDom", () => {
  it("og:title wins over h1 and title tag", () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Premium Widget Pro" />
          <title>Premium Widget Pro | Acme Store</title>
        </head>
        <body>
          <h1>Premium Widget</h1>
        </body>
      </html>
    `;
    const result = extractTitleFromDom(html);
    expect(result).not.toBeNull();
    expect(result!.extractedValue).toBe("Premium Widget Pro");
    expect(result!.confidence).toBe(0.85);
    expect(result!.sourcePointer).toContain('meta[property="og:title"]');
    expect(result!.extractionMethod).toBe("inferred");
    expect(result!.rawKey).toBe("title");
  });

  it("h1 wins when no og:title present", () => {
    const html = `
      <html>
        <head>
          <title>My Product | Shop Name</title>
        </head>
        <body>
          <h1>My Product</h1>
        </body>
      </html>
    `;
    const result = extractTitleFromDom(html);
    expect(result).not.toBeNull();
    expect(result!.extractedValue).toBe("My Product");
    expect(result!.confidence).toBe(0.75);
    expect(result!.sourcePointer).toContain("h1:first");
  });

  it("strips site-name suffix from <title> tag", () => {
    const html = `
      <html>
        <head>
          <title>Aonami Drill | Acme Hardware</title>
        </head>
        <body></body>
      </html>
    `;
    const result = extractTitleFromDom(html);
    expect(result).not.toBeNull();
    expect(result!.extractedValue).toBe("Aonami Drill");
    expect(result!.confidence).toBe(0.55);
    expect(result!.sourcePointer).toContain("<title>");
  });
});
