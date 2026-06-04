// Public entrypoint for @aonex/per-site-parsers.
//
// Re-exports the PerSiteParser type and registry functions (registerParser /
// findParserForUrl / listRegisteredParsers), then side-effect-imports every
// parser module so each self-registers on load. Importing this package is what
// makes the amazon/bestbuy/croma/ebay/walmart parsers discoverable by hostname.

export { type PerSiteParser } from "./types.js";
export { registerParser, findParserForUrl, listRegisteredParsers } from "./registry.js";

// Auto-register all parsers on import — populated incrementally by Phase 7 tasks.
// (Side-effect imports; each parser's module calls registerParser() at top level.)
import "./parsers/amazon.js";
import "./parsers/bestbuy.js";
import "./parsers/croma.js";
import "./parsers/ebay.js";
import "./parsers/walmart.js";
