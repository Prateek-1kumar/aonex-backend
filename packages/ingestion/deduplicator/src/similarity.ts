// Title similarity: Levenshtein-normalized, from the shared kernel.
// Choice documented in ADR-006: Levenshtein is conservative (HLD §13 requires
// "never auto-merge on title alone") and requires zero new packages.
// Trigram/cosine would be faster on long strings but adds complexity.

export { normalizedSimilarity } from "@aonex/lib-utils";
