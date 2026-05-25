// Public API surface for @aonex/catalog-service.
// See docs/superpowers/plans/2026-05-21-catalog-redesign.md tasks 3.2-3.11
// for the WHAT/WHY behind each module. Internal helpers under
// `reconciler/_internal.ts` are package-private and intentionally NOT
// re-exported here.

// ---------------------------------------------------------------------------
// Anomaly Lab — admitOrStage chokepoint (Task 5)
// ---------------------------------------------------------------------------
export { admitOrStage } from "./admit-or-stage.js";
export type {
  AdmitOrStageInput,
  AdmitOrStageResult
} from "./admit-or-stage.js";

// ---------------------------------------------------------------------------
// Anomaly Lab — promoteStagedProduct (Task 8)
// ---------------------------------------------------------------------------
export { promoteStagedProduct, StillIncompleteError } from "./staging/promote-staged.js";
export type {
  PromoteStagedInput,
  PromoteStagedResult
} from "./staging/promote-staged.js";

// ---------------------------------------------------------------------------
// Anomaly Lab — rejectStagedProduct + linkStagedProduct (Task 9)
// ---------------------------------------------------------------------------
export { rejectStagedProduct } from "./staging/reject-staged.js";
export type { RejectStagedInput } from "./staging/reject-staged.js";

export { linkStagedProduct } from "./staging/link-staged.js";
export type { LinkStagedInput } from "./staging/link-staged.js";

// ---------------------------------------------------------------------------
// Catalog write — adapter output → identity + storage
// ---------------------------------------------------------------------------
export { writeAdapterOutput } from "./catalog-write.js";
export type {
  WriteAdapterOutputInput,
  WriteAdapterOutputResult,
  WriteMatchPath
} from "./catalog-write.js";

// ---------------------------------------------------------------------------
// Approval — proposed diff → product version
// ---------------------------------------------------------------------------
export { applyApprovedDiff } from "./approve.js";
export type {
  ApplyApprovedDiffInput,
  ApplyApprovedDiffResult,
  CanonicalProductPayload,
  CanonicalVariantPayload
} from "./approve.js";

// ---------------------------------------------------------------------------
// Identity resolver — hint → product match
// ---------------------------------------------------------------------------
export { resolveIdentity } from "./identity-resolver.js";
export type {
  IdentityHint,
  IdentityMatchPath,
  IdentityResolverInput,
  IdentityResolverResult
} from "./identity-resolver.js";

// ---------------------------------------------------------------------------
// Identity policy — promote observed identity fields onto products
// ---------------------------------------------------------------------------
export { applyIdentityObservation } from "./identity-policy.js";
export type {
  ApplyIdentityObservationInput,
  ApplyIdentityObservationResult,
  IdentityField
} from "./identity-policy.js";

// ---------------------------------------------------------------------------
// Merge / unmerge / split — manual catalog hygiene operations
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Reconciler — pickWinner (pure) primitive used by both sync and async paths
// ---------------------------------------------------------------------------
export { globMatch, pickWinner, RECONCILER_VERSION } from "./reconciler/pick-winner.js";
export type {
  PickWinnerInput,
  PickWinnerObservation,
  PickWinnerResult,
  SourcePriorityRule,
  WinnerExplanation
} from "./reconciler/pick-winner.js";

// ---------------------------------------------------------------------------
// Reconciler — sync path (inline projection during write)
// ---------------------------------------------------------------------------
export { projectSync } from "./reconciler/sync.js";
export type { ProjectSyncInput, ProjectSyncResult } from "./reconciler/sync.js";

// ---------------------------------------------------------------------------
// Reconciler — async debounced path (BullMQ worker)
// ---------------------------------------------------------------------------
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
