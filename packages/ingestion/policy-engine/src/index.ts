// HLD §14 — Policy Engine public API.
export * from "./types.js";

// Plan B — multi-signal router (canonical going forward).
export { route, clusterKey } from "./router.js";

// Backward-compat alias for the legacy single-score caller.
// REMOVE after Plan B Task 14 lands and link-catalog-pipeline migrates.
export { score } from "./formula.js";
