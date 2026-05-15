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
  /**
   * Top-N canonical-path candidates from the Semantic Mapper.
   * `key` is a canonical attribute key, `score` is the mapping confidence
   * (independent of `confidence`, which scores the value itself).
   */
  mappingCandidates: Array<{ key: string; score: number; reason?: string }> | null;
  /**
   * Alternative sources from the structured-merge phase: when multiple
   * parsers extract the same rawKey, the loser facts are preserved here
   * with their real values and source pointers so downstream detectors
   * can compare values across sources. Null when there are no alts.
   */
  sourceAlternatives: Array<{ value: unknown; sourcePointer: string; confidence: number }> | null;
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
