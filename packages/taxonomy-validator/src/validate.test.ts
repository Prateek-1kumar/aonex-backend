import { describe, expect, test } from "bun:test";
import { validateAttributes } from "./validate.js";
import { coerceEnum, parseUnit } from "./normalize.js";
import type { LeafSchema } from "./types.js";

const jeans: LeafSchema = {
  nodeId: "fashion/clothing/bottoms/jeans",
  attributes: [
    { key: "color", tier: "required" },
    { key: "fit", tier: "required", enumValues: ["Skinny", "Slim", "Straight", "Relaxed"] },
    { key: "size", tier: "required" },
    { key: "waist_rise", tier: "recommended", enumValues: ["Low", "Mid", "High"] },
    { key: "weight", tier: "optional", dataType: "number", unit: "g", allowedUnits: ["g", "kg"] },
  ],
};

describe("coerceEnum", () => {
  test("exact / case / fuzzy / invalid", () => {
    expect(coerceEnum("Slim", jeans.attributes[1]!.enumValues!).status).toBe("ok");
    expect(coerceEnum("slim", jeans.attributes[1]!.enumValues!)).toMatchObject({ status: "coerced", value: "Slim" });
    expect(coerceEnum("skiny", jeans.attributes[1]!.enumValues!)).toMatchObject({ status: "coerced", value: "Skinny" });
    expect(coerceEnum("banana", jeans.attributes[1]!.enumValues!).status).toBe("invalid");
  });

  test("never fuzzes a value whose digits differ ('6G' is not a typo of '5G')", () => {
    expect(coerceEnum("6G", ["4G", "5G"]).status).toBe("invalid");
    expect(coerceEnum("USB 3", ["USB 2", "USB 4"]).status).toBe("invalid");
    // digit-preserving format coercion still works
    expect(coerceEnum("5g", ["4G", "5G"])).toMatchObject({ status: "coerced", value: "5G" });
  });

  test("short strings are not fuzz-coerced (similarity ratio, not flat budget)", () => {
    // one edit on a 2-char value = 0.5 similarity -> reject even without digits
    expect(coerceEnum("XL", ["XS", "SL"]).status).toBe("invalid");
  });
});

describe("parseUnit", () => {
  test("converts kg -> g and validates range-free", () => {
    expect(parseUnit("1.2 kg", "g", ["g", "kg"])).toMatchObject({ status: "coerced", value: 1200, unit: "g" });
    expect(parseUnit("500g", "g", ["g", "kg"])).toMatchObject({ value: 500, unit: "g" });
    expect(parseUnit("abc", "g")).toMatchObject({ status: "invalid" });
  });
});

describe("validateAttributes", () => {
  test("normalizes, flags invalid, scores by tier, lists missing required", () => {
    const r = validateAttributes(jeans, {
      color: "Indigo",
      fit: "slim", // coerced
      // size missing (required)
      waist_rise: "loww", // fuzzy -> Low
      weight: "1.5kg", // coerced -> 1500 g
    });
    const byKey = Object.fromEntries(r.fields.map((f) => [f.key, f]));
    expect(byKey.fit!.normalized).toBe("Slim");
    expect(byKey.waist_rise!.normalized).toBe("Low");
    expect(byKey.weight!.normalized).toEqual({ value: 1500, unit: "g" });
    expect(r.missingRequired).toEqual(["size"]);
    expect(r.violations).toBe(0);
    // required coverage = 2/3 (color+fit ok, size missing) -> dominates score
    expect(r.completeness.required).toBeCloseTo(2 / 3, 5);
    expect(r.completeness.score).toBeGreaterThan(50);
    expect(r.completeness.score).toBeLessThan(80);
  });

  test("invalid enum surfaces a suggestion and counts as a violation", () => {
    const r = validateAttributes(jeans, { color: "Blue", fit: "Bootcut", size: "32" });
    const fit = r.fields.find((f) => f.key === "fit")!;
    expect(fit.status).toBe("invalid");
    expect(fit.suggestion).toBeDefined();
    expect(r.violations).toBe(1);
  });
});
