# @aonex/ingestion-dom-heuristics

Extracts product fields directly from raw HTML using CSS-selector and regex heuristics when structured data (JSON-LD, Next.js, etc.) is absent or incomplete.

## Exports
- `runDomHeuristics(rawHtml)` — runs all extractors; returns `DomHeuristicResult` with a `facts` array
- `extractPriceFromDom`, `extractTitleFromDom`, `extractDescriptionFromDom` — individual field extractors
- `extractImagesFromDom`, `extractBreadcrumbFromDom`, `extractSpecTableFromDom`, `extractVariantSelectorFromDom`
- `DomHeuristicResult` — result type

## How it fits
Layer B (DOM heuristics) in the extraction stack, always run alongside structured parsers in `@aonex/link-adapter`'s `runExtractionLayers`. Its facts are merged with structured and per-site facts before the LLM gap-fill pass.

## Dependencies
- `@aonex/ingestion-field-extractor` (for `ExtractedFact` type)
