import { test, expect } from "bun:test";
import { toLabeledSamples } from "./calibration-bridge.js";
import type { ScoredField } from "./types.js";

test("only fields with a rawConfidence become calibration samples", () => {
  const scored: ScoredField[] = [
    { field: "title", expected: "x", extracted: "x", correct: true, weight: 0.8, rawConfidence: 0.9 },
    { field: "brand", expected: "y", extracted: "z", correct: false, weight: 0.8 }, // no rawConfidence
  ];
  const samples = toLabeledSamples([scored]);
  expect(samples.length).toBe(1);
  expect(samples[0]).toEqual({ rawConfidence: 0.9, outcome: 1 }); // outcome: 1=correct, 0=wrong
});
