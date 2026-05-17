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
