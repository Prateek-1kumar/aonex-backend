import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanHtml } from "./html-cleaner.js";

const decathlonHtml = readFileSync(
  join(__dirname, "../../structured/test/fixtures/decathlon.html"),
  "utf8"
);
const bewakoofHtml = readFileSync(
  join(__dirname, "../../structured/test/fixtures/bewakoof.html"),
  "utf8"
);

describe("cleanHtml", () => {
  it("returns structured blocks alongside cleaned text", () => {
    const result = cleanHtml(decathlonHtml);
    expect(result).toHaveProperty("structuredBlocks");
    expect(result).toHaveProperty("cleanedText");
    expect(result).toHaveProperty("captchaSignal");
    expect(result.captchaSignal).toBe(false);
  });

  it("preserves JSON-LD script content in structuredBlocks.jsonLd", () => {
    const { structuredBlocks } = cleanHtml(decathlonHtml);
    expect(Array.isArray(structuredBlocks.jsonLd)).toBe(true);
    expect(structuredBlocks.jsonLd.length).toBeGreaterThanOrEqual(3);
    const hasProduct = structuredBlocks.jsonLd.some(
      (b) => (b as Record<string, unknown>)["@type"] === "Product"
    );
    expect(hasProduct).toBe(true);
  });

  it("captures __NEXT_DATA__ block as structuredBlocks.nextData", () => {
    const { structuredBlocks } = cleanHtml(bewakoofHtml);
    expect(structuredBlocks.nextData).not.toBeNull();
    const nd = structuredBlocks.nextData as Record<string, unknown>;
    expect(nd).toHaveProperty("props");
  });

  it("removes scripts from cleanedText (LLM input)", () => {
    const { cleanedText } = cleanHtml(decathlonHtml);
    expect(cleanedText).not.toContain("application/ld+json");
    expect(cleanedText).not.toContain("__NEXT_DATA__");
  });

  it("center-preserving truncation when body > 200KB", () => {
    const huge = "<html><body>" + "X".repeat(300_000) + "</body></html>";
    const { cleanedText } = cleanHtml(huge);
    expect(cleanedText.length).toBeLessThanOrEqual(200_000 + 100);
    expect(cleanedText).toContain("[...middle truncated]");
  });

  it("flags captchaSignal=true for small body with captcha keyword", () => {
    const captcha =
      '<html><body>Robot Check — please complete the captcha</body></html>';
    const { captchaSignal } = cleanHtml(captcha);
    expect(captchaSignal).toBe(true);
  });

  it("captchaSignal=false for normal pages", () => {
    expect(cleanHtml(decathlonHtml).captchaSignal).toBe(false);
    expect(cleanHtml(bewakoofHtml).captchaSignal).toBe(false);
  });
});
