import { describe, expect, test } from "bun:test";
import { jaccard, normalizeText, numerals, tokenSet, valueToText } from "./text.js";

describe("normalizeText", () => {
  test("lowercases, folds separators, keeps digits", () => {
    expect(normalizeText("Levi's 511 Slim-Fit Jeans 32x32")).toBe("levis 511 slim fit jeans 32x32");
  });
  test("expands & and handles nullish", () => {
    expect(normalizeText("Head & Shoulders")).toBe("head and shoulders");
    expect(normalizeText(null)).toBe("");
  });
});

describe("numerals", () => {
  test("pulls all numbers incl. compound specs", () => {
    expect(numerals("225/45R17")).toEqual(["225", "45", "17"]);
    expect(numerals("128GB")).toEqual(["128"]);
  });
});

describe("valueToText", () => {
  test("flattens arrays and {value,unit} objects", () => {
    expect(valueToText(["a", "b"])).toBe("a b");
    expect(valueToText({ value: 16, unit: "oz" })).toBe("16 oz");
  });
});

describe("jaccard", () => {
  test("identical sets = 1, disjoint = 0", () => {
    expect(jaccard(tokenSet("nike running shoes"), tokenSet("nike running shoes"))).toBe(1);
    expect(jaccard(tokenSet("nike shoes"), tokenSet("apple iphone"))).toBe(0);
  });
});
