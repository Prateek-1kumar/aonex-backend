# @aonex/ingestion-spine

Orchestrates the shared ingestion pipeline that every data lane (link, CSV, Nango marketplace) passes through: persist artifact → extract → map → validate → score → diff → approve/review.

## Exports
- `runIngestion(input)` — drives the full pipeline; returns `approved`, `review`, `duplicate`, or `validation_failed`
- `IngestionAdapter` — interface all lane adapters implement (`normalize()` + `extract()`)
- `IngestionEnvelope` — the typed payload passed between `normalize` and `extract`
- `ExtractionHints`, `StageName`, `StageAuditMeta` — supporting types

## How it fits
The central runner used by the ingestion worker for every product source. `@aonex/link-adapter` implements `IngestionAdapter` for the URL lane and is passed into `runIngestion` alongside a DB client and audit emitter.

## Dependencies
- `@aonex/db`, `@aonex/audit`, `@aonex/types`
- `@aonex/ingestion-field-extractor`, `@aonex/ingestion-semantic-mapper`, `@aonex/ingestion-policy-engine`
- `@aonex/lib-utils`
