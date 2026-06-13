import { describe, expect, test } from "bun:test";
import { calibrate } from "./calibrate.js";

describe("calibrate", () => {
  test("grounded + valid + confident -> accepted, high", () => {
    const r = calibrate({ modelConfidence: 0.9, support: 1, grounding: "grounded", status: "ok" });
    expect(r.accepted).toBe(true);
    expect(r.calibratedConfidence).toBeGreaterThan(0.8);
  });

  test("missing -> 0, rejected", () => {
    const r = calibrate({ modelConfidence: 0.9, support: 0, grounding: "inferred", status: "missing" });
    expect(r).toEqual({ calibratedConfidence: 0, accepted: false, proposable: false });
  });

  test("inferred is proposable but not auto-accepted by default", () => {
    const r = calibrate({ modelConfidence: 0.9, support: 0.35, grounding: "inferred", status: "ok" });
    expect(r.accepted).toBe(false);
    expect(r.proposable).toBe(true);
  });

  test("invalid status -> capped + rejected even if model is sure", () => {
    const r = calibrate({ modelConfidence: 1, support: 1, grounding: "grounded", status: "invalid" });
    expect(r.accepted).toBe(false);
    expect(r.calibratedConfidence).toBeLessThanOrEqual(0.2);
  });

  test("contradicted -> hard reject", () => {
    const r = calibrate({ modelConfidence: 1, support: 0, grounding: "contradicted", status: "ok" });
    expect(r.accepted).toBe(false);
    expect(r.calibratedConfidence).toBeLessThanOrEqual(0.1);
  });

  test("inferred is capped below certainty even with high model confidence", () => {
    const r = calibrate({ modelConfidence: 1, support: 0.15, grounding: "inferred", status: "ok" });
    expect(r.calibratedConfidence).toBeLessThanOrEqual(0.6);
  });

  test("unverified -> capped below the review bar, never proposable (Gap A)", () => {
    // Even a maximally confident model can't push an unanchored fabrication into review.
    const r = calibrate({ modelConfidence: 1, support: 0.15, grounding: "unverified", status: "ok" });
    expect(r.calibratedConfidence).toBeLessThanOrEqual(0.3);
    expect(r.proposable).toBe(false);
    expect(r.accepted).toBe(false);
  });

  test("grounding outweighs a low self-report", () => {
    const low = calibrate({ modelConfidence: 0.2, support: 1, grounding: "grounded", status: "ok" });
    const high = calibrate({ modelConfidence: 1, support: 0.15, grounding: "inferred", status: "ok" });
    expect(low.calibratedConfidence).toBeGreaterThan(high.calibratedConfidence);
  });
});
