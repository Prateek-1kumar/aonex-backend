import { test, expect } from "bun:test";
import { flattenJsonLdNodes } from "./json-ld-blocks.js";

test("flattens @graph into individual nodes", () => {
  const parsed = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList" },
      { "@type": "Product", name: "Pixel 10" },
    ],
  };
  const nodes = flattenJsonLdNodes(parsed);
  expect(
    nodes.some((n) => n["@type"] === "Product" && n.name === "Pixel 10")
  ).toBe(true);
});

test("normalizes array @type so a Product is findable", () => {
  const parsed = { "@type": ["Product", "Thing"], name: "X" };
  const nodes = flattenJsonLdNodes(parsed);
  expect(nodes[0]!["@type"]).toContain("Product");
});

test("handles a top-level array of blocks", () => {
  const parsed = [
    { "@type": "Organization" },
    { "@graph": [{ "@type": "Product", name: "Y" }] },
  ];
  const nodes = flattenJsonLdNodes(parsed);
  expect(nodes.some((n) => n["@type"] === "Product")).toBe(true);
});
