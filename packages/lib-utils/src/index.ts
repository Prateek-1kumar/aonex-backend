// Public API of @aonex/lib-utils — shared low-level utilities.
//
// Barrel re-exporting canonical JSON stringify, sha256, Nango-metadata
// stripping, clock, backoff, URL/domain helpers (url.js), and unit
// conversion (units.js). Imported across workers and services.

export * from "./canonical-stringify.js";
export * from "./sha256.js";
export * from "./remove-nango-metadata.js";
export * from "./clock.js";
export * from "./backoff.js";
export * from "./url.js";
export { convertToCanonical, canonicalUnitFor, type Dimension } from "./units.js";
export * from "./edit-distance.js";
export * from "./text-normalize.js";
export * from "./gtin.js";
export type { ChatProvider } from "./chat-provider.js";
