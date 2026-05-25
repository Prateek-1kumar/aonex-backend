// Anomaly Lab — staging gate. The global core minimum the catalog requires
// to be "built perfectly". Category-specific attributes are nice-to-have,
// not gating (spec §3 decision 3, §5.1).

export const CANONICAL_MINIMUM = [
  "title",          // non-empty string
  "brand",          // non-empty string
  "pricing.primary",// currency + >= 1 tier amount
  "category_path",  // non-empty
  "identifier"      // >= 1 of gtin / mpn / primary_identifier non-empty
] as const;

export type CanonicalMinimumField = (typeof CANONICAL_MINIMUM)[number];
