# @aonex/ingestion-link-fetcher

Fetches a product page URL over plain HTTP, cleans the HTML, and returns a structured result ready for the extraction pipeline.

## Exports
- `fetchLink(url, options?)` — fetches, validates, and cleans an HTTP page; returns `LinkFetchResult`
- `cleanHtml(rawHtml)` — strips scripts/styles and extracts structured blocks (JSON-LD, Next.js data, etc.)
- `LinkFetchResult`, `LinkFetchOptions`, `StructuredBlocks`, `CleanResult`, `LinkFetchError` — core types
- `DEFAULT_FETCH_OPTIONS` — default timeout, user-agent, and body size cap

## How it fits
Layer A (static fetch) in the ingestion ladder. Called first by `@aonex/link-adapter`'s `runFetchEscalation`; the `rawHtml` and `structuredBlocks` it returns are passed downstream to structured parsers, DOM heuristics, and the LLM extractor.

## Dependencies
- `@aonex/lib-utils` (for `sha256Hex`, `canonicalizeUrl`)
