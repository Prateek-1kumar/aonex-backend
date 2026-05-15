import { describe, it, expect } from "bun:test";
import { detectCategoryAmbiguous } from "./category-ambiguous.js";

describe("detectCategoryAmbiguous", () => {
  it("fires when category confidence < 0.70", () => {
    const s = detectCategoryAmbiguous({
      category: { path: "x/y", confidence: 0.55 },
      facts: [], payload: {} as never, domain: "x.com",
    } as never);
    expect(s).not.toBeNull();
  });

  it("does not fire when category confidence ≥ 0.70", () => {
    expect(
      detectCategoryAmbiguous({
        category: { path: "x/y", confidence: 0.92 },
        facts: [], payload: {} as never, domain: "x.com",
      } as never)
    ).toBeNull();
  });

  it("fires when category path is null", () => {
    const s = detectCategoryAmbiguous({
      category: { path: null, confidence: 0 },
      facts: [], payload: {} as never, domain: "x.com",
    } as never);
    expect(s).not.toBeNull();
  });
});
