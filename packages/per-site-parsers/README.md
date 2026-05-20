# @aonex/per-site-parsers

Registry of hand-written, site-specific product parsers for Amazon, Best Buy, Walmart, eBay, and Croma that produce high-confidence `ExtractedFact` arrays from raw HTML.

## Exports
- `findParserForUrl(url)` — looks up a registered parser by hostname; returns `PerSiteParser | null`
- `registerParser(parser)` — adds a parser to the registry (called automatically on import)
- `listRegisteredParsers()` — returns a snapshot of all registered parsers (for diagnostics)
- `PerSiteParser` — interface: `domains`, `priority`, `fingerprint`, `requiresBrowser`, `extract()`

## How it fits
Layer G (highest-priority extraction rung) in `@aonex/link-adapter`'s `runExtractionLayers`. When a parser is registered for the URL's hostname, its facts win over generic structured/DOM facts on key collisions. `requiresBrowser: true` parsers (e.g. Amazon) also short-circuit static fetch in `runFetchEscalation`.

## Dependencies
- `@aonex/ingestion-field-extractor` (for `ExtractedFact` type)
