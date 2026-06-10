// Taxonomy classifier — contracts.
//
// The classifier resolves product signals to a canonical leaf node, with a
// confidence and ranked alternatives. It ABSTAINS (nodeId=null) rather than
// force-fit a low-confidence guess — abstentions route to the LLM fallback
// (P1.2) and ultimately the Lab. Pure: the index is supplied by the caller
// (built from the seeded taxonomy).

export interface ProductSignals {
  title?: string;
  brand?: string;
  /** Raw source/marketplace category string (often messy). */
  sourceCategory?: string;
  attributes?: Record<string, unknown>;
}

export interface LeafEntry {
  nodeId: string;
  displayName: string;
  /** Top-level department slug (node_id segment 0) — for context scoring. */
  departmentId: string;
  /** Pre-tokenized, singularized display-name tokens. */
  nameTokens: string[];
}

export interface ClassifierIndex {
  /** normalized label -> nodeId (the seeded taxonomy_aliases). */
  aliases: Map<string, string>;
  /** Leaf nodes to score lexically. */
  leaves: LeafEntry[];
}

export interface Candidate {
  nodeId: string;
  score: number;
}

export type ClassifyMethod = "alias" | "lexical" | "abstain";

export interface ClassifyResult {
  /** Resolved leaf, or null when abstaining (no confident match). */
  nodeId: string | null;
  /** 0..1. */
  confidence: number;
  method: ClassifyMethod;
  /** Top ranked candidates (incl. the winner when not abstaining). */
  alternatives: Candidate[];
}

export interface ClassifyOptions {
  /** Lexical score below this abstains. Default 0.5. */
  lexicalThreshold?: number;
  /** Max alternatives returned. Default 3. */
  topN?: number;
}
