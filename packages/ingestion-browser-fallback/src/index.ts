export {
  fetchWithBrowser,
  closeBrowserPool,
  type FetchBrowserResult
} from "./playwright-pool.js";
export {
  shouldEscalateToBrowser,
  type EscalationSignalInput,
  type EscalationDecision
} from "./escalation-signal.js";
