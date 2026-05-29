import { test, expect } from "bun:test";
import { fitIsotonic } from "@aonex/calibration";
import { calibrateFacts } from "./calibrate-confidence.js";

// A model fit from eval samples where raw 0.7 empirically meant ~0.5 accuracy.
const model = fitIsotonic([
  { rawConfidence: 0.7,  outcome: 0 },
  { rawConfidence: 0.7,  outcome: 1 },
  { rawConfidence: 0.95, outcome: 1 },
  { rawConfidence: 0.95, outcome: 1 },
]);

test("raw confidence is replaced by calibrated accuracy", () => {
  const out = calibrateFacts(
    [{ field: "brand", value: "Google", rawConfidence: 0.7 }],
    model
  );
  expect(out[0]!.confidence).toBeLessThanOrEqual(0.7); // 0.7 was only ~50% accurate empirically
});
