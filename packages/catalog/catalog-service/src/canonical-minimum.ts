// Staging-gate core minimum: the global fields the catalog requires before a
// product is "built perfectly". Category-specific attributes are not gating.
// "identifier" means a hard ID (gtin OR mpn OR merchant primary_identifier);
// brand is NOT an identifier.

export const CANONICAL_MINIMUM = [
  "title",
  "brand",
  "pricing.primary",
  "category_path",
  "identifier"
] as const;

export type CanonicalMinimumField = (typeof CANONICAL_MINIMUM)[number];
