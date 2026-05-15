// HLD §8 — Variant Extractor public API.
export * from "./types.js";
export { extractVariants } from "./extract.js";
export { normalizeAxisName, normalizeAxisValue } from "./normalize-axes.js";
export { checkVariantMatrix } from "./matrix-check.js";
export type { MatrixCheckInput, MatrixCheckResult } from "./matrix-check.js";
