# @aonex/multi-source-reconciler

Scores identity similarity between two product candidates and decides whether to auto-merge, flag for review, or keep them separate.

## Exports

- `computeMatchScore(a, b)` — returns a `MatchScoreBreakdown` with per-signal scores (GTIN 40%, MPN 20%, title similarity 25%, brand 15%) and a `composite` 0–1
- `decideReconciliationAction(a, b)` — returns `{ action: "merge" | "review" | "keep_separate", score }`
- `reconcileFields(a, b)` — field-level merge: higher-confidence value wins; ties go to most recent
- `jaroWinkler(s, t)` — string similarity used for title matching
- `WEIGHTS`, `THRESHOLDS`, `ProductIdentity`, `MatchScoreBreakdown`, `ReconciliationDecision`

## How it fits

Used by `packages/catalog/catalog-service` during the deduplication phase — after ingestion, before a product version is written to the canonical catalog.

## Dependencies

None (`@aonex/*`-free).
