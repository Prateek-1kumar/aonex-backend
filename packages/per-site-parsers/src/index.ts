export { type PerSiteParser } from "./types.js";
export { registerParser, findParserForUrl, listRegisteredParsers } from "./registry.js";

// Auto-register all parsers on import — populated incrementally by Phase 7 tasks.
// (Side-effect imports; each parser's module calls registerParser() at top level.)
