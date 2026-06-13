// Public API surface for @aonex/catalog-service. Internal helpers under
// `reconciler/_internal.ts` are package-private and intentionally NOT
// re-exported here.

export { admitOrStage } from "./admit-or-stage.js";
export type {
  AdmitOrStageInput,
  AdmitOrStageResult
} from "./admit-or-stage.js";

export { promoteStagedProduct, StillIncompleteError } from "./staging/promote-staged.js";
export type {
  PromoteStagedInput,
  PromoteStagedResult
} from "./staging/promote-staged.js";

export { rejectStagedProduct } from "./staging/reject-staged.js";
export type { RejectStagedInput } from "./staging/reject-staged.js";

export { linkStagedProduct } from "./staging/link-staged.js";
export type { LinkStagedInput } from "./staging/link-staged.js";

export { writeAdapterOutput } from "./catalog-write.js";
export type {
  WriteAdapterOutputInput,
  WriteAdapterOutputResult,
  WriteMatchPath
} from "./catalog-write.js";

export { applyApprovedDiff } from "./approve.js";
export type {
  ApplyApprovedDiffInput,
  ApplyApprovedDiffResult,
  CanonicalProductPayload,
  CanonicalVariantPayload
} from "./approve.js";

export { resolveIdentity } from "./identity-resolver.js";
export type {
  IdentityHint,
  IdentityMatchPath,
  IdentityResolverInput,
  IdentityResolverResult
} from "./identity-resolver.js";

export { applyIdentityObservation } from "./identity-policy.js";
export type {
  ApplyIdentityObservationInput,
  ApplyIdentityObservationResult,
  IdentityField
} from "./identity-policy.js";

export { mergeProducts, splitProduct, unmergeProduct } from "./merge.js";
export type {
  MergeProductsInput,
  MergeProductsResult,
  ObservationFilter,
  SplitProductInput,
  SplitProductResult,
  UnmergeProductInput,
  UnmergeProductResult
} from "./merge.js";

export { globMatch, pickWinner, RECONCILER_VERSION } from "./reconciler/pick-winner.js";
export type {
  PickWinnerInput,
  PickWinnerObservation,
  PickWinnerResult,
  SourcePriorityRule,
  WinnerExplanation
} from "./reconciler/pick-winner.js";

export { projectSync } from "./reconciler/sync.js";
export type { ProjectSyncInput, ProjectSyncResult } from "./reconciler/sync.js";

export {
  computeCompletenessScore,
  presentAttributes,
  type ScoreFacts
} from "./completeness-score.js";

export {
  enqueueReconcilerJob,
  extractPrimaryAmount,
  makeReconcilerWorker,
  processReconcilerJob,
  reconcilerJobId,
  reconcilerQueueName
} from "./reconciler/async-debounced.js";
export type {
  EnqueueReconcilerOpts,
  ProcessResult,
  ReconcilerAttributeCode,
  ReconcilerDeps,
  ReconcilerJobData
} from "./reconciler/async-debounced.js";

export {
  appendEnrichmentObservations,
  removeEnrichmentObservations,
  ENRICHMENT_SOURCE
} from "./enrichment-observations.js";
export type {
  AppendEnrichmentObservationsArgs,
  EnrichmentObservation
} from "./enrichment-observations.js";
