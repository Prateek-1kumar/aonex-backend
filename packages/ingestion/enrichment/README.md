# @aonex/ingestion-enrichment

Converts a flat list of `ExtractedFact` objects into a fully-typed `SkuJson` product record, normalizing images, classifying image roles, linking variant images, parsing units, and validating pricing/GTINs.

## Exports
- `convertFromFacts(facts, baseUrl, opts)` — primary builder; produces a `SkuJson`
- `SkuJson`, `SkuImage`, `SkuVariant`, `SourceTag` — canonical product schema types
- `normalizeImageUrls`, `classifyImageRoles`, `linkVariantsToImages` — image pipeline helpers
- `parseUnit` — extracts numeric value + unit string from strings like "3.5 kg"
- `validatePricing`, `validateGtin`, `dedupeVariantSkus`, `ValidationWarning` — sanity checks

## How it fits
Called at the end of the extraction pipeline in `@aonex/link-adapter` (`extract-layers.ts`) after all fact layers (structured, DOM, LLM, vision, per-site) have been merged. Produces the `skuJson` field attached to the returned `ExtractedFactSet`.

## Dependencies
- `@aonex/ingestion-field-extractor` (for `ExtractedFact` type)
