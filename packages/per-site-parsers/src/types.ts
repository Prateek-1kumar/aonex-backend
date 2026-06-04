// Shared contract for every site-specific parser in this package.
//
// Defines the PerSiteParser interface: the domains it claims, match priority,
// version fingerprint, browser-render requirement, and an extract() that turns
// raw HTML + URL into ExtractedFact[]. Implemented by each parsers/* module and
// consumed by the registry.

import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export interface PerSiteParser {
  /** Hostname patterns this parser claims. Match by exact suffix. */
  domains: string[];
  /** Higher wins when multiple parsers match (rare). Default 100. */
  priority: number;
  /** Version string; used by selector-health monitoring. */
  fingerprint: string;
  /** Whether this parser requires a browser-rendered HTML payload. */
  requiresBrowser: boolean;
  /** Run the parser. Return empty array when nothing matched. */
  extract(input: { rawHtml: string; url: string }): Promise<ExtractedFact[]>;
}
