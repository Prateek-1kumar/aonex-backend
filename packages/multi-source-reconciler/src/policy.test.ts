import { describe, it, expect } from "bun:test";
import { reconcileFields, decideReconciliationAction, type Field } from "./policy.js";

const f = <T>(value: T | null, confidence: number, observedAt = 1000): Field<T> => ({ value, confidence, observedAt });

describe("reconcileFields", () => {
  it("returns the only side when one is missing the field", () => {
    const result = reconcileFields(
      { title: f("From A", 0.9) },
      { brand: f("From B", 0.8) }
    );
    expect(result.fields.title).toBe("From A");
    expect(result.fields.brand).toBe("From B");
    expect(result.attribution.title).toBe("a");
    expect(result.attribution.brand).toBe("b");
  });

  it("higher-confidence wins on overlap", () => {
    const result = reconcileFields(
      { title: f("From A", 0.7) },
      { title: f("From B", 0.95) }
    );
    expect(result.fields.title).toBe("From B");
    expect(result.attribution.title).toBe("b");
  });

  it("tie on confidence → more recent observedAt wins", () => {
    const result = reconcileFields(
      { title: f("Old", 0.9, 100) },
      { title: f("New", 0.9, 200) }
    );
    expect(result.fields.title).toBe("New");
    expect(result.attribution.title).toBe("b");
  });

  it("treats null value as missing (other side wins by default)", () => {
    const result = reconcileFields(
      { brand: f(null, 0.95) },
      { brand: f("FromB", 0.7) }
    );
    expect(result.fields.brand).toBe("FromB");
    expect(result.attribution.brand).toBe("b");
  });

  it("returns null + 'neither' when neither side has a value", () => {
    const result = reconcileFields(
      { brand: f(null, 0.9) },
      { brand: f(null, 0.9) }
    );
    expect(result.fields.brand).toBeNull();
    expect(result.attribution.brand).toBe("neither");
  });
});

describe("decideReconciliationAction", () => {
  it("returns 'merge' when score >= 0.70 (GTIN match + similar title)", () => {
    const d = decideReconciliationAction(
      { gtin: "1234567890123", title: "Aonami Pro Drill", brand: "Aonami" },
      { gtin: "1234567890123", title: "Aonami Pro Drill (Cordless)", brand: "Aonami" }
    );
    expect(d.action).toBe("merge");
  });

  it("returns 'review' when score in [0.40, 0.70)", () => {
    const d = decideReconciliationAction(
      { gtin: "1234567890123", title: "Hammer", brand: "BrandA" },
      { gtin: "1234567890123", title: "Drill", brand: "BrandB" }
    );
    // GTIN match (1*0.40) + title diff (~0.3*0.25) + brand diff (0*0.15) ≈ 0.475
    expect(d.action).toBe("review");
  });

  it("returns 'keep_separate' when score < 0.40", () => {
    const d = decideReconciliationAction(
      { gtin: "111", title: "Hammer", brand: "A" },
      { gtin: "999", title: "Screwdriver", brand: "Z" }
    );
    expect(d.action).toBe("keep_separate");
  });

  it("includes the full score breakdown in the decision", () => {
    const d = decideReconciliationAction(
      { gtin: "111", title: "X" },
      { gtin: "111", title: "X" }
    );
    expect(d.score.gtin).toBe(1);
    expect(d.score.titleSimilarity).toBeCloseTo(1.0);
    expect(d.score.composite).toBeCloseTo(1.0);
  });
});
