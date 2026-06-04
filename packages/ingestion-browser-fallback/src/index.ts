// Public barrel for @aonex/ingestion-browser-fallback.
//
// Re-exports the Playwright pool's fetchWithBrowser /
// fetchWithBrowserAndScreenshot / closeBrowserPool plus the
// shouldEscalateToBrowser heuristic — the headless-render escape hatch used
// when static fetch (spec §6.3) is insufficient.

export {
  fetchWithBrowser,
  fetchWithBrowserAndScreenshot,
  closeBrowserPool,
  type FetchBrowserResult,
  type FetchBrowserWithScreenshotResult,
  type FetchBrowserWithScreenshotOptions
} from "./playwright-pool.js";
export {
  shouldEscalateToBrowser,
  type EscalationSignalInput,
  type EscalationDecision
} from "./escalation-signal.js";
