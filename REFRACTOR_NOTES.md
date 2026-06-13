# REFRACTOR_NOTES.md (backend)

Notes from the behavior-preserving cleanliness pass on branch
`chore/production-refactor`. Records: the verified baseline (parity target), bugs/risks
spotted but **deliberately NOT fixed** (RULE ZERO), removed TODOs/commented-out code,
folded/dropped "why" knowledge, and any dead code left in place.

## Baseline (captured before any change)
- **typecheck**: GREEN — `bun run typecheck` exit 0 (77 turbo tasks, + `tsc -p scripts`).
- **lint**: GREEN — `bun run lint` exit 0 (41 tasks; 1 pre-existing warning in `@aonex/lib-utils`).
- **test**: `bun run test` — 17 packages have test suites. Failures below are
  infra-dependent (no live Postgres/Redis; LLM 429s) and form the parity baseline.

| Package | pass | fail | skip |
|---|---|---|---|
| @aonex/api | 132 | 5 | 4 |
| @aonex/archetypes | 19 | 0 | 0 |
| @aonex/catalog-event-outbox | 79 | 3 | 0 |
| @aonex/catalog-service | 342 | 8 | 0 |
| @aonex/catalog-source-adapters | 154 | 0 | 0 |
| @aonex/catalog-watchdog | 9 | 19 | 0 |
| @aonex/connector-gateway | 42 | 5 | 0 |
| @aonex/db | 74 | 17 | 0 |
| @aonex/gtin-backfill | 10 | 0 | 0 |
| @aonex/ingestion-eval | 88 | 0 | 0 |
| @aonex/lib-utils | 41 | 0 | 0 |
| @aonex/taxonomy-classifier | 18 | 0 | 0 |
| @aonex/taxonomy-enrichment | 82 | 0 | 0 |
| @aonex/taxonomy-schema | 14 | 0 | 0 |
| @aonex/taxonomy-validator | 12 | 0 | 0 |
| @aonex/types | 6 | 0 | 0 |
| @aonex/worker | 121 | 8 | 0 |

Turbo test tasks reporting failure (≥1 failing test, all infra-dependent):
`api, catalog-event-outbox, catalog-service, catalog-watchdog, connector-gateway, db, worker`.

---

## Bugs / risks spotted — NOT fixed (RULE ZERO)
<!-- agents append: `- <file>: <observation>` -->

## Removed TODO/FIXME and commented-out code
<!-- agents append: `- <file>: <what it said>` -->

## "Why" knowledge folded into headers / dropped
<!-- agents append: `- <file>: folded <X> into header` or `dropped <Y>` -->

## Dead code left in place (uncertain) + reason
<!-- agents append: `- <file>: <symbol> — left because <reason>` -->

## Stale docs deleted or corrected
<!-- B2 appends -->
