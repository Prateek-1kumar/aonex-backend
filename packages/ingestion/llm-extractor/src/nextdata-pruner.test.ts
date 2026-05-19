import { describe, it, expect } from "bun:test";
import { pruneNextData } from "./nextdata-pruner.js";

describe("pruneNextData", () => {
  it("keeps product-related subtrees", () => {
    const input = { props: { pageProps: { product: { name: "X" }, footerNav: ["a","b"] } } };
    const out = pruneNextData(input);
    expect(JSON.stringify(out)).toContain("product");
    expect(JSON.stringify(out)).not.toContain("footerNav");
  });

  it("returns null for non-object input", () => {
    expect(pruneNextData(null)).toBeNull();
    expect(pruneNextData("string")).toBeNull();
  });

  it("caps output at 4KB", () => {
    const big = { props: { product: { description: "x".repeat(20000) } } };
    const out = pruneNextData(big);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4096);
  });
});
