import { describe, it, expect } from "bun:test";
import {
  newPrior,
  updatePrior,
  betaBinomialPosterior,
  updateFromSamples
} from "./beta-binomial.js";

describe("Beta-binomial reliability prior", () => {
  it("newPrior returns Laplace-smoothed Beta(1,1) prior", () => {
    const prior = newPrior();
    expect(prior.alpha).toBe(1);
    expect(prior.beta).toBe(1);
    expect(betaBinomialPosterior(prior)).toBe(0.5);
  });

  it("updatePrior increments alpha on success, beta on failure", () => {
    const p1 = updatePrior(newPrior(), 1);
    expect(p1).toEqual({ alpha: 2, beta: 1 });
    const p2 = updatePrior(p1, 0);
    expect(p2).toEqual({ alpha: 2, beta: 2 });
  });

  it("posterior mean trends toward observed rate with more samples", () => {
    // 10 successes, 0 failures
    let prior = newPrior();
    for (let i = 0; i < 10; i++) prior = updatePrior(prior, 1);
    expect(betaBinomialPosterior(prior)).toBeCloseTo(11 / 12);    // (1+10)/(1+10+1)
  });

  it("updateFromSamples applies a sequence", () => {
    const prior = updateFromSamples(newPrior(), [1, 1, 0, 1, 0, 1, 1, 1, 1, 0]);
    // 7 successes, 3 failures → (1+7)/(1+7+1+3) = 8/12 = 0.667
    expect(betaBinomialPosterior(prior)).toBeCloseTo(8 / 12);
  });

  it("a single sample doesn't collapse to 0 or 1 (Laplace smoothing)", () => {
    const allSuccess = updateFromSamples(newPrior(), [1]);
    expect(betaBinomialPosterior(allSuccess)).toBeCloseTo(2 / 3);    // not 1.0
    const allFail = updateFromSamples(newPrior(), [0]);
    expect(betaBinomialPosterior(allFail)).toBeCloseTo(1 / 3);    // not 0.0
  });

  it("approaches true rate asymptotically with large samples", () => {
    // True rate = 0.7 across 1000 samples
    const samples: (0 | 1)[] = Array.from({ length: 1000 }, (_, i) => (i < 700 ? 1 : 0) as 0 | 1);
    const prior = updateFromSamples(newPrior(), samples);
    expect(betaBinomialPosterior(prior)).toBeCloseTo(0.7, 2);
  });
});
