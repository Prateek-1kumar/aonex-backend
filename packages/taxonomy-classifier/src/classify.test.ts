import { describe, expect, test } from "bun:test";
import { classify, buildIndex } from "./classify.js";

const leaves = [
  { nodeId: "fashion/clothing/bottoms/jeans", displayName: "Jeans" },
  { nodeId: "fashion/footwear/sneakers", displayName: "Sneakers" },
  { nodeId: "electronics/mobile-phones-and-accessories/mobile-phones", displayName: "Mobile Phones" },
  { nodeId: "office-and-school-supplies/office-supplies/office-chairs", displayName: "Office Chairs" },
  { nodeId: "home-and-kitchen/home-appliances/refrigerators", displayName: "Refrigerators" },
];
const aliases = new Map<string, string>([
  ["jeans", "fashion/clothing/bottoms/jeans"],
  ["smartphone", "electronics/mobile-phones-and-accessories/mobile-phones"],
]);
const index = buildIndex(leaves, aliases);

describe("classify", () => {
  test("alias hit on source category", () => {
    const r = classify({ title: "Levi's 511", sourceCategory: "Jeans" }, index);
    expect(r.method).toBe("alias");
    expect(r.nodeId).toBe("fashion/clothing/bottoms/jeans");
  });

  test("alias hit via title token", () => {
    const r = classify({ title: "Best Smartphone 2024", sourceCategory: "gadgets" }, index);
    expect(r.nodeId).toBe("electronics/mobile-phones-and-accessories/mobile-phones");
  });

  test("lexical multi-word match (Office Chairs)", () => {
    const r = classify({ title: "Ergonomic Mesh Office Chair Black", sourceCategory: "furniture" }, index);
    expect(r.method).toBe("lexical");
    expect(r.nodeId).toBe("office-and-school-supplies/office-supplies/office-chairs");
  });

  test("abstains on no confident match", () => {
    const r = classify({ title: "DJI Mavic 3 Drone", sourceCategory: "aerial" }, index);
    expect(r.nodeId).toBeNull();
    expect(r.method).toBe("abstain");
  });

  test("brand tokens do not drive the match", () => {
    const r = classify({ title: "Samsung Refrigerator 500L", brand: "Samsung", sourceCategory: "appliances" }, index);
    expect(r.nodeId).toBe("home-and-kitchen/home-appliances/refrigerators");
  });
});
