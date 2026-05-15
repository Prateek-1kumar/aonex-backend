import { describe, it, expect } from "bun:test";
import { detectIdentityConflict } from "./identity-conflict.js";

describe("detectIdentityConflict", () => {
  it("fires when GTIN matches existing product with different brand", () => {
    const s = detectIdentityConflict({
      payload: { gtin: "1234", brand: "Brand A", canonicalCategory: "x/y" } as never,
      identityIndex: { gtin: { productId: "p1", brand: "Brand B", canonicalCategory: "x/y" } },
      domain: "ex.com",
      facts: [],
    } as never);
    expect(s).not.toBeNull();
    expect(s!.severity).toBe("critical");
  });

  it("does not fire when brand matches", () => {
    expect(
      detectIdentityConflict({
        payload: { gtin: "1234", brand: "Same Brand", canonicalCategory: "x/y" } as never,
        identityIndex: { gtin: { productId: "p1", brand: "Same Brand", canonicalCategory: "x/y" } },
        domain: "ex.com",
        facts: [],
      } as never)
    ).toBeNull();
  });
});
