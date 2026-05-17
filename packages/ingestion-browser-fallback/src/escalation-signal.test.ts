import { describe, it, expect } from "bun:test";
import { shouldEscalateToBrowser } from "./escalation-signal.js";

const SHORT_HTML = "<html><body>tiny</body></html>";
const LONG_HTML = "<html><body>" + "x".repeat(50_000) + "</body></html>";

describe("shouldEscalateToBrowser", () => {
  it("escalates when body < 30kb AND no structured data", () => {
    const result = shouldEscalateToBrowser({
      rawHtml: SHORT_HTML,
      hasJsonLd: false,
      hasNextData: false,
      hasNuxt: false,
      coveragePercent: 0.8
    });
    expect(result.escalate).toBe(true);
    expect(result.reasons).toContain("no_structured_data");
  });

  it("escalates when body < 30kb AND coverage < 50%", () => {
    const result = shouldEscalateToBrowser({
      rawHtml: SHORT_HTML,
      hasJsonLd: true,
      hasNextData: false,
      hasNuxt: false,
      coveragePercent: 0.3
    });
    expect(result.escalate).toBe(true);
  });

  it("does NOT escalate with only one signal (e.g., short body alone)", () => {
    const result = shouldEscalateToBrowser({
      rawHtml: SHORT_HTML,
      hasJsonLd: true,
      hasNextData: false,
      hasNuxt: false,
      coveragePercent: 0.8
    });
    expect(result.escalate).toBe(false);
    expect(result.reasons).toHaveLength(1);
  });

  it("detects noscript enable-javascript banner", () => {
    const html = `<html><body><noscript>Please enable JavaScript</noscript></body></html>`;
    const result = shouldEscalateToBrowser({
      rawHtml: html,
      hasJsonLd: false,
      hasNextData: false,
      hasNuxt: false,
      coveragePercent: 0.8
    });
    expect(result.escalate).toBe(true);
    expect(result.reasons).toContain("noscript_enable_js");
  });

  it("does NOT escalate when content is rich and structured", () => {
    const result = shouldEscalateToBrowser({
      rawHtml: LONG_HTML,
      hasJsonLd: true,
      hasNextData: true,
      hasNuxt: false,
      coveragePercent: 0.9
    });
    expect(result.escalate).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});
