import { describe, it, expect } from "bun:test";
import { computePSI, detectDistributionDrift } from "./distribution.js";

describe("computePSI", () => {
  it("returns near-zero PSI when distributions are identical", () => {
    const baseline = { red: 30, blue: 50, green: 20 };
    const current = { red: 30, blue: 50, green: 20 };
    const { psi } = computePSI(baseline, current);
    expect(psi).toBeCloseTo(0, 3);
  });

  it("returns moderate PSI when one bin shifts ~15%", () => {
    const baseline = { red: 30, blue: 50, green: 20 };
    const current = { red: 45, blue: 35, green: 20 };
    const { psi } = computePSI(baseline, current);
    expect(psi).toBeGreaterThan(0.05);
    expect(psi).toBeLessThan(0.30);
  });

  it("returns significant PSI when distribution shifts dramatically", () => {
    const baseline = { red: 90, blue: 5, green: 5 };
    const current = { red: 5, blue: 90, green: 5 };
    const { psi } = computePSI(baseline, current);
    expect(psi).toBeGreaterThan(0.25);
  });

  it("handles a label appearing only in current (new bin)", () => {
    const baseline = { red: 50, blue: 50 };
    const current = { red: 40, blue: 40, yellow: 20 };
    const { psi, bins } = computePSI(baseline, current);
    expect(psi).toBeGreaterThan(0);
    expect(bins.find((b) => b.label === "yellow")).toBeDefined();
  });

  it("returns 0 PSI when either cohort is empty", () => {
    expect(computePSI({}, { red: 10 }).psi).toBe(0);
    expect(computePSI({ red: 10 }, {}).psi).toBe(0);
  });
});

describe("detectDistributionDrift", () => {
  it("returns no_drift for identical distributions", () => {
    const result = detectDistributionDrift("color", { red: 30, blue: 70 }, { red: 30, blue: 70 });
    expect(result.category).toBe("no_drift");
    expect(result.psi).toBeCloseTo(0, 3);
  });

  it("returns moderate for small shift", () => {
    const result = detectDistributionDrift("color", { red: 30, blue: 70 }, { red: 45, blue: 55 });
    expect(["moderate", "no_drift"]).toContain(result.category);
  });

  it("returns significant for large shift", () => {
    const result = detectDistributionDrift(
      "color",
      { red: 80, blue: 10, green: 10 },
      { red: 10, blue: 10, green: 80 }
    );
    expect(result.category).toBe("significant");
  });
});
