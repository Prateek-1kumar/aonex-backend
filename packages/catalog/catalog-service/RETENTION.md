# Observation Retention

Each `catalog_products.values[attr][channel][locale]` leaf is capped at
**`DEFAULT_OBSERVATION_CAP = 20`** observations. When a new observation lands and
the leaf already has 20, the **oldest by `observed_at`** is evicted into the
revision row's `diff.overflow_eviction` and persisted in the append-only
`catalog_product_revisions` table — never silently dropped.

## Why 20?

- **Identity-policy quorum (spec §6.1):** the policy gate needs 3 consecutive
  priority-1 observations to update `brand`/`model_number`, and 5 consecutive
  priority-1 observations to auto-unfreeze. 20 leaves room for a healthy mix
  of source/locale combinations while still keeping the JSONB row tight.
- **Eval calibration runway:** `@aonex/calibration`'s isotonic fitter consumes
  per-product labeled samples (Phase −1). Keeping ~20 newest observations per
  attribute keeps recent-evidence available without bloating the audit trail.
- **JSONB bloat ceiling:** at ~20 observations × ~10 attributes × a few
  channels, the per-row JSONB stays in the kilobytes — well within
  Postgres's tolerance for indexed JSONB read paths.

## Why "newest wins"?

The eviction algorithm in `catalog-write.ts` (the `while (leaf.length > cap)`
loop in `applyAdapterOutput`) finds the entry with the minimum `observed_at`
and splices it out. This is intentionally **not** insertion-order:

- A late-arriving observation with an OLDER `observed_at` (e.g. a CSV upload
  of historical pricing) does not evict newer evidence.
- Re-ingests with the same `observed_at` are deduped earlier via
  `(source, sourceRecordId, value)` equality, so the cap rarely fires on
  benign duplicates.

## Where eviction goes

Every evicted observation is captured in the same write's
`catalog_product_revisions.diff.overflow_eviction` JSON field. Nothing is lost
— the audit trail is the system of record; `values` is a hot read cache.
