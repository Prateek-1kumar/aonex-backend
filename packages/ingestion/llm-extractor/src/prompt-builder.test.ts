import { describe, it, expect } from "bun:test";
import { buildExtractionPrompt } from "./prompt-builder.js";

describe("buildExtractionPrompt", () => {
  it("emits gap schema when gaps[] provided", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "irrelevant",
      url: "https://x.com/p",
      gaps: ["material", "fit"],
      categoryCandidates: ["apparel/t_shirts"],
    });
    const sys = msgs[0]!.content;
    expect(sys).toContain('"material"');
    expect(sys).toContain('"fit"');
    expect(sys).not.toContain("LAUNCH_CATEGORIES"); // no hardcoded ref
  });

  it("emits full schema when no gaps", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "...",
      url: "https://x.com/p",
      categoryCandidates: ["apparel/t_shirts"],
    });
    const sys = msgs[0]!.content;
    expect(sys).toContain('"variants"');
    expect(sys).toContain('"option_values"');
  });

  it("includes categoryCandidates in the system prompt", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "...",
      url: "https://x.com/p",
      categoryCandidates: ["apparel/t_shirts", "apparel/shirts"],
    });
    expect(msgs[0]!.content).toContain("apparel/t_shirts");
    expect(msgs[0]!.content).toContain("apparel/shirts");
  });
});

describe("buildExtractionPrompt — structured hints", () => {
  it("includes JSON-LD blocks in system message when provided", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "x",
      url: "https://x.com",
      structuredHints: { jsonLd: [{ "@type": "Product", name: "S" }] }
    });
    expect(msgs[0]!.content).toContain("JSON-LD");
    expect(msgs[0]!.content).toContain('"@type": "Product"');
  });

  it("includes meta tags formatted as key=value", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "x",
      url: "https://x.com",
      structuredHints: { metaTags: { "og:image": "https://x.com/i.jpg" } }
    });
    expect(msgs[0]!.content).toContain("og:image");
    expect(msgs[0]!.content).toContain("https://x.com/i.jpg");
  });

  it("lists raw image URLs (cap 30)", () => {
    const urls = Array.from({ length: 40 }, (_, i) => `https://x.com/${i}.jpg`);
    const msgs = buildExtractionPrompt({
      cleanedText: "x",
      url: "https://x.com",
      structuredHints: { rawImageUrls: urls }
    });
    expect(msgs[0]!.content).toContain("https://x.com/0.jpg");
    expect(msgs[0]!.content).not.toContain("https://x.com/30.jpg");
  });

  it("emits no STRUCTURED HINTS section when hints is undefined", () => {
    const msgs = buildExtractionPrompt({ cleanedText: "x", url: "https://x.com" });
    expect(msgs[0]!.content).not.toContain("STRUCTURED HINTS");
  });
});

describe("buildExtractionPrompt — Phase 2 rich schema in prompt", () => {
  it("renderFullSchema includes pricing.sale_price", () => {
    const msgs = buildExtractionPrompt({ cleanedText: "x", url: "https://x.com" });
    expect(msgs[0]!.content).toContain("pricing");
    expect(msgs[0]!.content).toContain("sale_price");
  });

  it("renderFullSchema includes shipping.weight and dimensions", () => {
    const msgs = buildExtractionPrompt({ cleanedText: "x", url: "https://x.com" });
    expect(msgs[0]!.content).toContain("shipping");
    expect(msgs[0]!.content).toContain("weight");
    expect(msgs[0]!.content).toContain("dimensions");
  });

  it("gap mode renders nested pricing schema for sale_price gap", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "x",
      url: "https://x.com",
      gaps: ["sale_price"]
    });
    expect(msgs[0]!.content).toContain("pricing");
    expect(msgs[0]!.content).toContain("sale_price");
  });

  it("gap mode renders flat schema for unknown gap", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "x",
      url: "https://x.com",
      gaps: ["material"]
    });
    expect(msgs[0]!.content).toContain('"material"');
  });
});

describe("buildExtractionPrompt — category-aware attributes", () => {
  it("emits CATEGORY-SPECIFIC ATTRIBUTES section when categoryCandidates provided", () => {
    const msgs = buildExtractionPrompt({
      cleanedText: "x",
      url: "https://x.com",
      categoryCandidates: ["electronics > headphones"]
    });
    expect(msgs[0]!.content).toContain("CATEGORY-SPECIFIC ATTRIBUTES");
    expect(msgs[0]!.content).toContain("battery_life");
  });

  it("falls back to generic when no categoryCandidates", () => {
    const msgs = buildExtractionPrompt({ cleanedText: "x", url: "https://x.com" });
    expect(msgs[0]!.content).toContain("category: generic");
  });
});
