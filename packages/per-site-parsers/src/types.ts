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
