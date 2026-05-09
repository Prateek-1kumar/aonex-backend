// HLD §9 / §20 — ExtractedFact and ExtractedFactSet shapes.
// Pure data types — no DB, no side effects.

import type { ArtifactId } from "@aonex/types";

/** HLD §20 — one extracted attribute fact with full provenance. */
export interface ExtractedFact {
  /** Raw marketplace field name, e.g. "vendor" */
  rawKey: string;
  /** Null until the Semantic Mapper assigns a canonical path */
  canonicalPath: string | null;
  extractedValue: unknown;
  normalizedValue: unknown;
  unit: string | null;
  /** JSONPath into source_artifacts.raw_data, e.g. "$.variants[0].barcode" */
  sourcePointer: string;
  extractionMethod: "direct" | "computed" | "inferred";
  /** 0..1 — how confident we are the value is correct */
  confidence: number;
  mappingMethod: string | null;
  mappingCandidates: Array<{ key: string; score: number }> | null;
  approved: boolean;
}

/** One artifact's complete set of extracted facts. */
export interface ExtractedFactSet {
  artifactId: ArtifactId;
  marketplace: string;
  extractorVersion: string;
  facts: ExtractedFact[];
  extractedAt: Date;
}

/** Contract every marketplace extractor must satisfy. */
export interface ArtifactExtractor {
  version: string;
  extract(rawData: Record<string, unknown>, artifactId: ArtifactId): ExtractedFactSet;
}
