# @aonex/selector-health

Emits structured audit events that track which DOM selectors and extraction-ladder rungs fired during each ingestion, powering per-domain selector health dashboards.

## Exports
- `recordSelectorFiring(input)` — emits a `selector.fired` audit event with success/failure for a specific selector ID and domain
- `recordLadderRung(input)` — emits a `ladder.rung_fired` event recording which rung (json_ld, llm_gap_fill, vision_llm, etc.) produced a given field
- `SelectorFiringInput`, `LadderRungInput`, `LadderRung` — input types

## How it fits
Called by extraction packages (per-site parsers, structured parsers) and the ingestion worker after each extraction run. Events are aggregated by a Phase 8 `selector-health-scan` cron job that surfaces "silent LLM rescue" patterns — i.e., when a normally-reliable rung's success rate drops and LLM calls spike.

## Dependencies
- `@aonex/audit` (for `AuditEmitter`), `@aonex/types` (for `TenantId`)
