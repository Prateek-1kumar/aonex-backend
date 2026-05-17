import { describe, it, expect } from "bun:test";
import { parseBreadcrumbList } from "./breadcrumb-list.js";

const BREADCRUMB_3_ITEMS: Record<string, unknown>[] = [
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Electronics", "item": "https://shop.example.com/electronics" },
      { "@type": "ListItem", "position": 2, "name": "Televisions", "item": "https://shop.example.com/electronics/tvs" },
      { "@type": "ListItem", "position": 3, "name": "Aonami Vision 55" },
    ],
  },
];

const BREADCRUMB_4_ITEMS: Record<string, unknown>[] = [
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home" },
      { "@type": "ListItem", "position": 2, "name": "Power Tools" },
      { "@type": "ListItem", "position": 3, "name": "Drills" },
      { "@type": "ListItem", "position": 4, "name": "Aonami Pro Drill 18V" },
    ],
  },
];

const BREADCRUMB_ONLY_PRODUCT: Record<string, unknown>[] = [
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Only Product" },
    ],
  },
];

const NO_BREADCRUMB: Record<string, unknown>[] = [
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Some Product",
  },
];

const EMPTY_BLOCKS: Record<string, unknown>[] = [];

const MIXED_BLOCKS: Record<string, unknown>[] = [
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Widget",
  },
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Widgets" },
      { "@type": "ListItem", "position": 2, "name": "Super Widget" },
    ],
  },
];

describe("parseBreadcrumbList", () => {
  it("extracts category_path from BreadcrumbList with 3 items (drops last)", () => {
    const result = parseBreadcrumbList(BREADCRUMB_3_ITEMS);
    expect(result.kind).toBe("breadcrumb_list");
    expect(result.baselineConfidence).toBe(0.65);

    const byKey = (k: string) => result.facts.find((f) => f.rawKey === k);
    const catFact = byKey("category_path");
    expect(catFact).toBeDefined();
    // chain = ["Electronics", "Televisions"] → "electronics/televisions"
    expect(catFact?.extractedValue).toBe("electronics/televisions");
    // chainLen=2 → confidence = 0.50 + 0.10 * 2 = 0.70
    expect(catFact?.confidence).toBeCloseTo(0.70, 5);
  });

  it("returns empty facts when no BreadcrumbList block is present", () => {
    const result = parseBreadcrumbList(NO_BREADCRUMB);
    expect(result.kind).toBe("breadcrumb_list");
    expect(result.facts).toEqual([]);
  });

  it("returns empty facts on empty jsonLd blocks", () => {
    const result = parseBreadcrumbList(EMPTY_BLOCKS);
    expect(result.kind).toBe("breadcrumb_list");
    expect(result.facts).toEqual([]);
  });

  it("returns empty facts when BreadcrumbList has only 1 item (drops last → nothing left)", () => {
    const result = parseBreadcrumbList(BREADCRUMB_ONLY_PRODUCT);
    expect(result.kind).toBe("breadcrumb_list");
    expect(result.facts).toEqual([]);
  });

  it("handles 4-item breadcrumb — drops last, joins 3 items", () => {
    const result = parseBreadcrumbList(BREADCRUMB_4_ITEMS);
    const catFact = result.facts.find((f) => f.rawKey === "category_path");
    expect(catFact).toBeDefined();
    // chain = ["Home","Power Tools","Drills"] → "home/power tools/drills"
    expect(catFact?.extractedValue).toBe("home/power tools/drills");
    // chainLen=3 → confidence = 0.50 + 0.10 * 3 = 0.80
    expect(catFact?.confidence).toBeCloseTo(0.80, 5);
  });

  it("works when BreadcrumbList is mixed with other JSON-LD blocks", () => {
    const result = parseBreadcrumbList(MIXED_BLOCKS);
    const catFact = result.facts.find((f) => f.rawKey === "category_path");
    expect(catFact).toBeDefined();
    // chain = ["Widgets"] → "widgets" (1 item after dropping "Super Widget")
    expect(catFact?.extractedValue).toBe("widgets");
    // chainLen=1 → confidence = 0.50 + 0.10 * 1 = 0.60
    expect(catFact?.confidence).toBeCloseTo(0.60, 5);
  });

  it("emitted fact uses extractionMethod=computed", () => {
    const result = parseBreadcrumbList(BREADCRUMB_3_ITEMS);
    for (const f of result.facts) {
      expect(f.extractionMethod).toBe("computed");
    }
  });

  it("confidence caps at 4 items in chain (0.50 + 0.10*4 = 0.90)", () => {
    const longBreadcrumb: Record<string, unknown>[] = [
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "A" },
          { "@type": "ListItem", "position": 2, "name": "B" },
          { "@type": "ListItem", "position": 3, "name": "C" },
          { "@type": "ListItem", "position": 4, "name": "D" },
          { "@type": "ListItem", "position": 5, "name": "E" },
          { "@type": "ListItem", "position": 6, "name": "Product" },
        ],
      },
    ];
    const result = parseBreadcrumbList(longBreadcrumb);
    const catFact = result.facts.find((f) => f.rawKey === "category_path");
    // chainLen=5, but capped at 4 → 0.50 + 0.10*4 = 0.90
    expect(catFact?.confidence).toBeCloseTo(0.90, 5);
  });
});
