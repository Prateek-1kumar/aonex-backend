import { describe, it, expect } from "bun:test";
import { fitIsotonic, applyIsotonic, type LabeledSample } from "./isotonic.js";

describe("fitIsotonic", () => {
  it("returns empty model for empty input", () => {
    const model = fitIsotonic([]);
    expect(model.thresholds).toEqual([]);
    expect(model.values).toEqual([]);
  });

  it("returns identity-ish for monotone samples (already non-decreasing)", () => {
    // 10 samples with rising confidence and rising accuracy — PAVA shouldn't pool.
    const samples: LabeledSample[] = [
      { rawConfidence: 0.1, outcome: 0 },
      { rawConfidence: 0.3, outcome: 0 },
      { rawConfidence: 0.5, outcome: 1 },
      { rawConfidence: 0.7, outcome: 1 },
      { rawConfidence: 0.9, outcome: 1 }
    ];
    const model = fitIsotonic(samples);
    expect(model.thresholds.length).toBeGreaterThan(0);
    // First value should equal first outcome (0); last value should equal last (1).
    expect(model.values[0]).toBe(0);
    expect(model.values[model.values.length - 1]).toBe(1);
  });

  it("pools adjacent violators when a higher raw confidence has lower accuracy", () => {
    // 0.3 → outcome=1 (high), 0.7 → outcome=0 (low). PAVA pools them.
    const samples: LabeledSample[] = [
      { rawConfidence: 0.1, outcome: 0 },
      { rawConfidence: 0.3, outcome: 1 },
      { rawConfidence: 0.7, outcome: 0 },
      { rawConfidence: 0.9, outcome: 1 }
    ];
    const model = fitIsotonic(samples);
    // The middle two get pooled to 0.5
    // Values must be non-decreasing
    for (let i = 1; i < model.values.length; i++) {
      expect(model.values[i]).toBeGreaterThanOrEqual(model.values[i - 1]!);
    }
  });

  it("groups identical raw_confidence into a single point with mean outcome", () => {
    const samples: LabeledSample[] = [
      { rawConfidence: 0.5, outcome: 0 },
      { rawConfidence: 0.5, outcome: 1 },
      { rawConfidence: 0.5, outcome: 1 },
      { rawConfidence: 0.5, outcome: 1 }
    ];
    const model = fitIsotonic(samples);
    expect(model.thresholds).toEqual([0.5]);
    expect(model.values[0]).toBeCloseTo(0.75);
  });

  it("handles many overconfident samples (recalibrates downward)", () => {
    // 100 samples at confidence 0.95 with only 60% accuracy.
    const samples: LabeledSample[] = Array.from({ length: 100 }, (_, i) => ({
      rawConfidence: 0.95 as number,
      outcome: (i < 60 ? 1 : 0) as 0 | 1
    }));
    const model = fitIsotonic(samples);
    expect(applyIsotonic(model, 0.95)).toBeCloseTo(0.6);
  });
});

describe("applyIsotonic", () => {
  it("returns identity for empty model", () => {
    expect(applyIsotonic({ thresholds: [], values: [] }, 0.5)).toBe(0.5);
  });

  it("clamps to first value when input is below all thresholds", () => {
    const model = { thresholds: [0.3, 0.6, 0.9], values: [0.2, 0.5, 0.8] };
    expect(applyIsotonic(model, 0.0)).toBe(0.2);
  });

  it("clamps to last value when input is above all thresholds", () => {
    const model = { thresholds: [0.3, 0.6, 0.9], values: [0.2, 0.5, 0.8] };
    expect(applyIsotonic(model, 1.0)).toBe(0.8);
  });

  it("returns step value for input in range", () => {
    const model = { thresholds: [0.3, 0.6, 0.9], values: [0.2, 0.5, 0.8] };
    expect(applyIsotonic(model, 0.5)).toBe(0.5);    // <= 0.6 → 0.5
  });

  it("end-to-end: fit then apply produces calibrated outputs", () => {
    const samples: LabeledSample[] = [];
    // Build a calibration set where raw 0.9 only succeeds 70% of the time
    for (let i = 0; i < 30; i++) {
      samples.push({ rawConfidence: 0.9, outcome: (i < 21 ? 1 : 0) as 0 | 1 });
    }
    // And raw 0.5 succeeds 50%
    for (let i = 0; i < 30; i++) {
      samples.push({ rawConfidence: 0.5, outcome: (i < 15 ? 1 : 0) as 0 | 1 });
    }
    const model = fitIsotonic(samples);
    expect(applyIsotonic(model, 0.9)).toBeCloseTo(0.7, 1);
    expect(applyIsotonic(model, 0.5)).toBeCloseTo(0.5, 1);
  });
});
