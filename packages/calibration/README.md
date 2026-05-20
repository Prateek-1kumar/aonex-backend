# @aonex/calibration

Calibrates raw extractor confidence scores to empirical accuracy using isotonic regression (PAVA) and maintains per-domain field reliability estimates via a Beta-Binomial model.

## Exports

- `fitIsotonic(samples)` / `applyIsotonic(model, rawConfidence)` — fit and apply a Pool Adjacent Violators monotone step function mapping raw confidence → calibrated accuracy
- `IsotonicModel`, `LabeledSample` — model and training sample types
- `betaBinomialPosterior(prior)` — posterior mean from `Beta(alpha, beta)`; gives reliability estimate in (0, 1)
- `updatePrior(prior, outcome)` — Bayesian update on a reviewer approval/rejection
- `ReliabilityPrior` — `{ alpha, beta }` accumulator per domain × field

## How it fits

Used by `apps/worker` during the post-extraction confidence adjustment step, before proposed diffs are written and routed to reviewers.

## Dependencies

None (`@aonex/*`-free).
