# @aonex/drift-detector

Detects data drift in ingested product attributes across three dimensions: null-rate spikes, value distribution shifts (PSI), and schema key appearance/disappearance.

## Exports

- `computeNullRate(records, fields)` / `detectNullRateDrift(baseline, current, threshold?)` — flag fields whose null rate jumped by more than `threshold` (default 10%)
- `computePSI(baselineCounts, currentCounts)` / `detectDistributionDrift(field, baseline, current)` — Population Stability Index; categorizes as `no_drift | moderate | significant`
- `detectSchemaDrift(baselineRecords, currentRecords, options?)` — finds keys that newly appeared or vanished above a frequency threshold
- Result types: `NullRateResult`, `NullRateDriftReport`, `PSIResult`, `DistributionDriftReport`, `SchemaDriftReport`

## How it fits

Used by `apps/worker` in the drift-scan cron job (Phase 8) to surface selector breakage and catalog shifts before they propagate into the canonical catalog.

## Dependencies

None (`@aonex/*`-free).
