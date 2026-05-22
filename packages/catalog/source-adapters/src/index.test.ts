import { describe, expect, test } from "bun:test";
import { getAdapter } from "./index.js";

describe("adapter registry", () => {
  test("link adapter is registered", () => {
    const a = getAdapter("link");
    expect(a.sourceKind).toBe("link");
  });
  test("shopify-connector adapter is registered", () => {
    const a = getAdapter("shopify-connector");
    expect(a.sourceKind).toBe("shopify-connector");
  });
  test("csv adapter is registered", () => {
    const a = getAdapter("csv");
    expect(a.sourceKind).toBe("csv");
  });
});
