import { describe, it, expect } from "bun:test";
import { classifyImageRoles } from "./image-role-classifier.js";

describe("classifyImageRoles", () => {
  it("marks first non-noise image as hero", () => {
    const out = classifyImageRoles([{ url: "https://x.com/a.jpg", alt: null }], null);
    expect(out[0]?.role).toBe("hero");
  });

  it("marks og:image match as hero even when not first", () => {
    const out = classifyImageRoles([
      { url: "https://x.com/a.jpg", alt: null },
      { url: "https://x.com/hero.jpg", alt: null }
    ], "https://x.com/hero.jpg");
    expect(out.find((i) => i.url.endsWith("hero.jpg"))?.role).toBe("hero");
  });

  it("marks lifestyle by alt text", () => {
    const out = classifyImageRoles([{ url: "https://x.com/a.jpg", alt: "in-use on-model lifestyle" }], null);
    expect(out[0]?.role).toBe("lifestyle");
  });

  it("marks spec by URL path", () => {
    const out = classifyImageRoles([{ url: "https://x.com/spec-diagram.jpg", alt: null }], null);
    expect(out[0]?.role).toBe("spec");
  });

  it("marks video_thumb by URL pattern", () => {
    const out = classifyImageRoles([{ url: "https://x.com/video_thumb_abc.jpg", alt: null }], null);
    expect(out[0]?.role).toBe("video_thumb");
  });

  it("defaults remaining to gallery", () => {
    const out = classifyImageRoles([
      { url: "https://x.com/a.jpg", alt: null },
      { url: "https://x.com/b.jpg", alt: null }
    ], "https://x.com/a.jpg");
    expect(out[1]?.role).toBe("gallery");
  });

  it("forces first to hero when og match misses", () => {
    const out = classifyImageRoles([
      { url: "https://x.com/a.jpg", alt: null },
      { url: "https://x.com/b.jpg", alt: null }
    ], "https://x.com/notpresent.jpg");
    expect(out[0]?.role).toBe("hero");
  });

  it("populates position field", () => {
    const out = classifyImageRoles([
      { url: "https://x.com/a.jpg", alt: null },
      { url: "https://x.com/b.jpg", alt: null }
    ], null);
    expect(out[0]?.position).toBe(0);
    expect(out[1]?.position).toBe(1);
  });
});
