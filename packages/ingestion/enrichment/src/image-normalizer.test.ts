import { describe, it, expect } from "bun:test";
import { normalizeImageUrls } from "./image-normalizer.js";

describe("normalizeImageUrls", () => {
  it("resolves relative URL against base", () => {
    expect(normalizeImageUrls([{ url: "/img/a.jpg" }], "https://x.com/p/1")[0]?.url)
      .toBe("https://x.com/img/a.jpg");
  });

  it("resolves protocol-relative URL", () => {
    expect(normalizeImageUrls([{ url: "//cdn.x.com/a.jpg" }], "https://site.com/p")[0]?.url)
      .toBe("https://cdn.x.com/a.jpg");
  });

  it("picks largest srcset", () => {
    expect(normalizeImageUrls([{ url: "x.jpg", srcset: "small.jpg 1x, big.jpg 2x" }], "https://x.com")[0]?.url)
      .toBe("https://x.com/big.jpg");
  });

  it("drops data: URIs", () => {
    expect(normalizeImageUrls([{ url: "data:image/png;base64,abc" }], "https://x.com")).toHaveLength(0);
  });

  it("dedupes by exact URL", () => {
    expect(normalizeImageUrls([{ url: "/a.jpg" }, { url: "/a.jpg" }], "https://x.com")).toHaveLength(1);
  });

  it("drops tracking pixels (path)", () => {
    expect(normalizeImageUrls([{ url: "/beacon/track.gif" }], "https://x.com")).toHaveLength(0);
  });

  it("drops favicons", () => {
    expect(normalizeImageUrls([{ url: "/favicon.ico" }], "https://x.com")).toHaveLength(0);
  });

  it("upscales Shopify _small to base", () => {
    expect(normalizeImageUrls([{ url: "/cdn/products/abc_small.jpg" }], "https://x.com")[0]?.url)
      .toBe("https://x.com/cdn/products/abc.jpg");
  });

  it("preserves alt text", () => {
    expect(normalizeImageUrls([{ url: "/a.jpg", alt: "Hat" }], "https://x.com")[0]?.alt).toBe("Hat");
  });
});
