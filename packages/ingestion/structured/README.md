# @aonex/ingestion-structured

Runs a battery of structured-data parsers (JSON-LD, microdata, RDFa, OpenGraph, Next.js, Nuxt, Shopify, WooCommerce, Magento, Algolia, BreadcrumbList) against a fetched page and merges their outputs into a unified fact set.

## Exports
- `extractStructured(input)` — top-level orchestrator; returns `ExtractStructuredOutput` with facts, per-parser results, coverage, and captcha signal
- `checkCoverage(facts, required)` — returns `CoverageResult` with `gaps` list
- `isCaptchaWall(rawHtml)` — detects captcha/block pages before parsing
- `StructuredResult`, `ParserOutput`, `ParserKind`, `ExtractStructuredInput` — schema types

## How it fits
Layer A (structured extraction) in the ingestion ladder, always run first by `@aonex/link-adapter`'s `runExtractionLayers`. Coverage gaps from this layer determine what the LLM gap-fill layer is asked to fill.

## Dependencies
- `@aonex/ingestion-link-fetcher` (for `StructuredBlocks` type), `@aonex/ingestion-field-extractor`
