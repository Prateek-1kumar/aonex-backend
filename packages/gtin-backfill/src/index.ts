// Public surface of `@aonex/gtin-backfill` — cost-capped, multi-source GTIN
// backfill (Phase 2).
//
// Re-exports backfillGtin (look up GTIN candidates from injected registries
// in parallel — icecat / upcitemdb — budget-gated) and roundTripMatches (D3
// guard: trust a backfilled GTIN only when brand + title match ours).

export const GTIN_BACKFILL_PACKAGE = "@aonex/gtin-backfill";
export { roundTripMatches } from "./round-trip.js";
export {
  backfillGtin,
  type RegistryHit,
  type BackfilledIdentifier,
  type BackfillDeps,
  type BackfillResult,
} from "./lookup.js";
