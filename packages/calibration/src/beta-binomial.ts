/**
 * Spec §14.4 — per-(domain × field) reliability prior.
 *
 * Beta(alpha, beta) is the conjugate prior for a Bernoulli outcome (correct/wrong).
 * Each reviewer correction shifts the posterior: approvals increment alpha,
 * rejections increment beta. Posterior mean = alpha / (alpha + beta) gives
 * the reliability estimate.
 *
 * We add a +1/+1 (Laplace) smoothing baseline so a single sample doesn't
 * collapse the estimate to 0 or 1.
 */

export interface ReliabilityPrior {
  /** Successes + alpha smoothing prior */
  alpha: number;
  /** Failures + beta smoothing prior */
  beta: number;
}

const ALPHA_PRIOR = 1;
const BETA_PRIOR = 1;

export function newPrior(): ReliabilityPrior {
  return { alpha: ALPHA_PRIOR, beta: BETA_PRIOR };
}

export function updatePrior(prior: ReliabilityPrior, outcome: 0 | 1): ReliabilityPrior {
  return {
    alpha: prior.alpha + (outcome === 1 ? 1 : 0),
    beta: prior.beta + (outcome === 0 ? 1 : 0)
  };
}

/**
 * Posterior mean of Beta(alpha, beta). Returns the calibrated reliability
 * estimate as a value in (0, 1).
 */
export function betaBinomialPosterior(prior: ReliabilityPrior): number {
  return prior.alpha / (prior.alpha + prior.beta);
}

/**
 * Convenience: bulk-update from a sequence of outcomes.
 */
export function updateFromSamples(
  prior: ReliabilityPrior,
  outcomes: ReadonlyArray<0 | 1>
): ReliabilityPrior {
  let next = prior;
  for (const o of outcomes) next = updatePrior(next, o);
  return next;
}
