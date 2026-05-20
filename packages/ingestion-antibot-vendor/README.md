# @aonex/ingestion-antibot-vendor

Wraps the ScrapingBee unblock API (residential proxies + JS rendering) for fetching pages that defeat plain HTTP and headless Chromium.

## Exports
- `createScrapingBeeAdapter(client)` — creates an `ScrapingBeeAdapter` from any client implementing `ScrapingBeeClient`
- `unblockWithScrapingBee(url, opts?)` — convenience wrapper that reads `SCRAPINGBEE_API_KEY` from env
- `withinCostCeiling(currentCredits, additional)` — guards against per-ingestion overspend
- `creditsToUsd(credits)`, `COST_CONSTANTS` — credit-to-dollar conversion helpers
- `UnblockResult`, `UnblockOptions`, `ScrapingBeeClient` — integration types

## How it fits
Layer D (unblock vendor) in the fetch escalation ladder, invoked by `@aonex/link-adapter`'s `runFetchEscalation` only when both static fetch and browser fallback return anemic responses and the cost ceiling allows it.

## Dependencies
- `scrapingbee` SDK (optional peer; only loaded at runtime when API key is set)
