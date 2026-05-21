// Catalog service — the new model.
// Rewrite in progress. Phase 3 will add: identity resolver, reconciler (pickWinner + sync + async),
// catalog write service, merge/unmerge/split, watchdogs, and the public API surface.
// See docs/superpowers/plans/2026-05-21-catalog-redesign.md tasks 3.2-3.11.

export { resolveIdentity } from "./identity-resolver.js";
export type {
  IdentityHint,
  IdentityResolverInput,
  IdentityResolverResult,
  IdentityMatchPath
} from "./identity-resolver.js";

export { pickWinner, globMatch, RECONCILER_VERSION } from "./reconciler/pick-winner.js";
export type {
  PickWinnerInput,
  PickWinnerObservation,
  PickWinnerResult,
  SourcePriorityRule,
  WinnerExplanation
} from "./reconciler/pick-winner.js";
