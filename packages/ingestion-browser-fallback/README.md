# @aonex/ingestion-browser-fallback

Fetches product pages through a pooled headless Chromium instance (Playwright) and optionally captures a PNG screenshot for the vision extraction tier.

## Exports
- `fetchWithBrowser(url, opts?)` — renders a URL with headless Chrome; returns `FetchBrowserResult`
- `fetchWithBrowserAndScreenshot(url, opts?)` — same but also returns `screenshotBase64` (PNG)
- `closeBrowserPool()` — graceful shutdown; call from worker exit hook
- `shouldEscalateToBrowser(opts)` — heuristic signal detector (body size, structured-data absence, coverage) that decides whether browser rendering is needed
- `EscalationSignalInput`, `EscalationDecision`, `FetchBrowserResult`, `FetchBrowserWithScreenshotResult`

## How it fits
Layer C (browser fallback) in the fetch escalation ladder. `@aonex/link-adapter`'s `runFetchEscalation` calls `fetchWithBrowser` when the static fetch is insufficient. `fetchWithBrowserAndScreenshot` is called by `runExtractionLayers` before the vision LLM tier.

## Dependencies
- `playwright` (peer dependency; Chromium binary must be installed)
