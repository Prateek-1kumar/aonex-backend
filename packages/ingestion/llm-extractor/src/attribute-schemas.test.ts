import { describe, it, expect } from "bun:test";
import { pickAttributeSchema, ATTRIBUTE_SCHEMAS } from "./attribute-schemas.js";

describe("pickAttributeSchema", () => {
  it("returns generic when confidence < 0.6", () => {
    expect(pickAttributeSchema("electronics > phones", 0.4).category).toBe("generic");
  });

  it("returns generic when category is null", () => {
    expect(pickAttributeSchema(null, 1.0).category).toBe("generic");
  });

  it("matches apparel keywords", () => {
    expect(pickAttributeSchema("clothing > shoes", 0.7).category).toBe("apparel");
  });

  it("matches electronics keywords", () => {
    expect(pickAttributeSchema("electronics > headphones", 0.7).category).toBe("electronics");
    expect(pickAttributeSchema("computer > laptop", 0.7).category).toBe("electronics");
  });

  it("matches beauty keywords", () => {
    expect(pickAttributeSchema("beauty > skincare", 0.7).category).toBe("beauty");
  });

  it("matches food keywords", () => {
    expect(pickAttributeSchema("grocery > snacks", 0.7).category).toBe("food");
  });

  it("matches furniture keywords", () => {
    expect(pickAttributeSchema("home > sofas", 0.7).category).toBe("furniture");
  });

  it("matches toys keywords", () => {
    expect(pickAttributeSchema("toys > games", 0.7).category).toBe("toys");
  });

  it("falls back to generic for unknown category", () => {
    expect(pickAttributeSchema("some-unknown-category", 0.7).category).toBe("generic");
  });

  it("returns the right keys for each bucket", () => {
    expect(pickAttributeSchema("apparel", 0.9).keys).toContain("material");
    expect(pickAttributeSchema("electronics", 0.9).keys).toContain("battery_life");
    expect(pickAttributeSchema("beauty", 0.9).keys).toContain("ingredients");
  });
});
