import { describe, it, expect } from "bun:test";
import { detectUnitAmbiguity } from "./unit-ambiguity.js";

describe("detectUnitAmbiguity", () => {
  it("fires when numeric value has no unit AND rawKey suggests a measurement", () => {
    const facts = [
      { rawKey: "battery_capacity", extractedValue: 5000, unit: null, confidence: 0.8 } as never,
    ];
    const s = detectUnitAmbiguity({ facts, payload: {} as never, domain: "x.com" } as never);
    expect(s).not.toBeNull();
    expect(s!.signalKind).toBe("unit_conflict");
  });

  it("does not fire when unit is present", () => {
    const facts = [{ rawKey: "battery_capacity", extractedValue: 5000, unit: "mAh", confidence: 0.8 } as never];
    expect(detectUnitAmbiguity({ facts, payload: {} as never, domain: "x.com" } as never)).toBeNull();
  });

  it("does not fire for canonical-axis fields like size", () => {
    const facts = [{ rawKey: "variants[0].option.size", extractedValue: "M", unit: null, confidence: 0.9 } as never];
    expect(detectUnitAmbiguity({ facts, payload: {} as never, domain: "x.com" } as never)).toBeNull();
  });
});
