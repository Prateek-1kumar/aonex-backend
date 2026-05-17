import type { IngestionEnvelope, IngestionLane } from "./types.js";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

export interface AdapterInput {
  /** Single URL for LinkAdapter; file path for CsvAdapter; etc. */
  sourceRef: string;
  /** Optional hints passed by the API caller (categoryHint, etc.). */
  hints?: { categoryHint?: string; localeHint?: string };
}

export interface IngestionAdapter {
  readonly lane: IngestionLane;

  /**
   * Yield IngestionEnvelopes one at a time. The adapter handles all
   * lane-specific fetching, parsing, pagination, etc. The downstream
   * orchestrator owns persistence, mapping, validation, scoring,
   * diffing, approval, and audit emission.
   */
  normalize(input: AdapterInput): AsyncIterable<IngestionEnvelope>;

  /**
   * Extract a fact set from one envelope. Lane-specific:
   *   - LinkAdapter: runs Layers A–H (parsers, DOM, browser, LLM, vision, per-site)
   *   - CsvAdapter: maps CSV columns to a fact set
   *   - NangoAdapter: wraps per-marketplace field extractor
   */
  extract(envelope: IngestionEnvelope): Promise<ExtractedFactSet>;
}

export type { IngestionEnvelope, ExtractionHints } from "./types.js";
