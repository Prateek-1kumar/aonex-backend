// Public API of @aonex/selector-health.
//
// Re-exports recordSelectorFiring (per-selector success/failure counter) and
// recordLadderRung (which fetch/extract ladder rung produced a field). Workers
// call these during ingestion so the Phase 8 cron can detect selector rot.

export {
  recordSelectorFiring,
  type SelectorFiringInput
} from "./counter.js";
export {
  recordLadderRung,
  type LadderRung,
  type LadderRungInput
} from "./ladder-logger.js";
