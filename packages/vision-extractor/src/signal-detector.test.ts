import { describe, it, expect } from "bun:test";
import { shouldEscalateToVision } from "./signal-detector.js";

describe("shouldEscalateToVision", () => {
  it("does NOT escalate when no signal is present", () => {
    const decision = shouldEscalateToVision({
      rawHtml: "<html><body>normal page</body></html>",
      hasTextPrice: true,
      upstreamFactCount: 10
    });
    expect(decision.escalate).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it("flags size-chart signal on size-chart img patterns", () => {
    const html = `<html><img src="/cdn/size-chart-mens-shoes.png" alt="Size chart"></html>`;
    const decision = shouldEscalateToVision({
      rawHtml: html,
      hasTextPrice: true,
      upstreamFactCount: 3
    });
    expect(decision.reasons).toContain("size_chart_image");
    expect(decision.escalate).toBe(true);
  });

  it("flags spec-graphic signal", () => {
    const html = `<html><img class="spec-image" src="/p/spec.jpg"></html>`;
    const decision = shouldEscalateToVision({
      rawHtml: html,
      hasTextPrice: true,
      upstreamFactCount: 3
    });
    expect(decision.reasons).toContain("spec_graphic_image");
  });

  it("flags image-rendered-price ONLY when hasTextPrice is false", () => {
    const html = `<html><img src="/banner/price-graphic.png"></html>`;
    const withPrice = shouldEscalateToVision({ rawHtml: html, hasTextPrice: true, upstreamFactCount: 3 });
    expect(withPrice.reasons).not.toContain("image_rendered_price");
    const withoutPrice = shouldEscalateToVision({ rawHtml: html, hasTextPrice: false, upstreamFactCount: 3 });
    expect(withoutPrice.reasons).toContain("image_rendered_price");
  });

  it("flags image-carousel + no-text-price + low-fact-count", () => {
    const html = `<html><div class="image-carousel"><img></div></html>`;
    const decision = shouldEscalateToVision({
      rawHtml: html,
      hasTextPrice: false,
      upstreamFactCount: 1
    });
    expect(decision.reasons).toContain("no_text_price_with_image_carousel");
  });

  it("does NOT escalate even with signal when upstream has many facts AND text price", () => {
    const html = `<html><img src="/size-chart.png"></html>`;
    const decision = shouldEscalateToVision({
      rawHtml: html,
      hasTextPrice: true,
      upstreamFactCount: 20    // many facts already
    });
    // Signal present but escalation gated by "few facts OR no price"
    expect(decision.escalate).toBe(false);
    expect(decision.reasons).toContain("size_chart_image");
  });

  it("escalates on signal when text price is missing even with many facts", () => {
    const html = `<html><img src="/size-chart.png"></html>`;
    const decision = shouldEscalateToVision({
      rawHtml: html,
      hasTextPrice: false,
      upstreamFactCount: 20
    });
    expect(decision.escalate).toBe(true);
  });
});
