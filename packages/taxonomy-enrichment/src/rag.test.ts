import { describe, expect, test } from "bun:test";
import { departmentOf, retrieveExamples } from "./rag.js";
import type { CatalogEntry } from "./types.js";

const corpus: CatalogEntry[] = [
  { title: "Apple iPhone 14 128GB Blue", brand: "Apple", nodeId: "electronics/mobile-phones-and-accessories/mobile-phones", attrs: { storage: "128GB", color: "Blue" } },
  { title: "Samsung Galaxy S23 256GB", brand: "Samsung", nodeId: "electronics/mobile-phones-and-accessories/mobile-phones", attrs: { storage: "256GB" } },
  { title: "Dell XPS 13 Laptop", brand: "Dell", nodeId: "electronics/computers-and-laptops/laptops", attrs: { ram: "16GB" } },
  { title: "Nike Air Max Sneakers", brand: "Nike", nodeId: "fashion/footwear/sneakers", attrs: { color: "White" } },
  { title: "Empty Example Phone", nodeId: "electronics/mobile-phones-and-accessories/mobile-phones", attrs: {} },
];

describe("departmentOf", () => {
  test("first path segment", () => {
    expect(departmentOf("fashion/clothing/jeans")).toBe("fashion");
    expect(departmentOf(undefined)).toBeUndefined();
  });
});

describe("retrieveExamples", () => {
  test("ranks same-node products first", () => {
    const ex = retrieveExamples(
      { title: "Apple iPhone 15 128GB Black", brand: "Apple", nodeId: "electronics/mobile-phones-and-accessories/mobile-phones" },
      corpus,
      { k: 2 }
    );
    expect(ex.length).toBe(2);
    expect(ex[0]!.nodeId).toBe("electronics/mobile-phones-and-accessories/mobile-phones");
    // the same-department laptop should rank below same-node phones
    expect(ex.map((e) => e.title)).not.toContain("Nike Air Max Sneakers");
  });

  test("drops examples with no attributes", () => {
    const ex = retrieveExamples(
      { title: "Generic Phone", nodeId: "electronics/mobile-phones-and-accessories/mobile-phones" },
      corpus,
      { k: 5 }
    );
    expect(ex.map((e) => e.title)).not.toContain("Empty Example Phone");
  });

  test("never retrieves the query product itself (no answer leakage)", () => {
    const ex = retrieveExamples(
      { title: "Apple iPhone 14 128GB Blue", brand: "Apple", nodeId: "electronics/mobile-phones-and-accessories/mobile-phones" },
      corpus,
      { k: 5 }
    );
    expect(ex.map((e) => e.title)).not.toContain("Apple iPhone 14 128GB Blue");
  });
});
