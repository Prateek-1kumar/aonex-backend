# @aonex/link-adapter

Implements the `IngestionAdapter` interface for the URL lane, orchestrating a multi-tier fetch escalation ladder (static → browser → unblock) and a multi-layer extraction stack (structured, DOM, LLM gap-fill, vision, per-site parsers).

## Exports
- `createLinkAdapter(deps)` — factory that wires all extraction tiers into an `IngestionAdapter`
- `createLinkAdapterWithAntibot(deps)` — same but auto-wires ScrapingBee when `SCRAPINGBEE_API_KEY` is set
- `LinkAdapter` — concrete class (for testing)
- `LinkAdapterDeps` — injectable dependencies (fetcher, llmExtractor, browserFetcher, unblockAdapter, domHeuristics, findPerSiteParser, screenshotFetcher, visionExtractor, cache)
- `EscalatedTo`, `BrowserFetcher`, `UnblockAdapter` — supporting types

### Internal modules (not re-exported but key to understand)
- `fetch-escalation.ts` — `runFetchEscalation`: static → browser → unblock decision logic with anemic-response detection
- `extract-layers.ts` — `runExtractionLayers`: per-site → structured → DOM → LLM → vision merge with `BudgetTracker`

## How it fits
The link-lane adapter passed to `@aonex/ingestion-spine`'s `runIngestion` by the ingestion worker. Consumes all extraction packages and produces the `ExtractedFactSet` (including `skuJson`) that the spine persists and diffs.

## Dependencies
- `@aonex/ingestion-spine`, `@aonex/ingestion-link-fetcher`, `@aonex/ingestion-llm-extractor`
- `@aonex/ingestion-structured`, `@aonex/ingestion-dom-heuristics`, `@aonex/ingestion-browser-fallback`
- `@aonex/ingestion-antibot-vendor`, `@aonex/ingestion-enrichment`, `@aonex/vision-extractor`
- `@aonex/per-site-parsers`, `@aonex/ingestion-field-extractor`, `@aonex/lib-utils`
