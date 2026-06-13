// Public surface of @aonex/ingestion-spine.
//
// Re-exports the IngestionAdapter port, the runIngestion orchestrator entry
// point (plus its Input/Result types), and the StageName/StageAuditMeta types.
// This is everything the worker imports to drive an ingestion through the spine.

export type { IngestionAdapter, IngestionEnvelope, ExtractionHints } from "./adapter.js";
export {
  runIngestion,
  type RunIngestionInput,
  type RunIngestionResult,
  type SpineCategoryClassifier,
  type SpineCategorySignals,
  type SpineCategoryResult
} from "./orchestrator.js";
export { type StageName, type StageAuditMeta } from "./types.js";
