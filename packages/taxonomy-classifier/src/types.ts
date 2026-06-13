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
  /** Departments (level-0) for fallback routing / new-node proposals. */
  departments: { id: string; name: string }[];
}

// ── Fallback resolver (P1.2): pluggable layer below the deterministic abstain ──

export interface ResolverInput {
  signals: ProductSignals;
  /** Top deterministic candidates with display names + scores. */
  candidates: { nodeId: string; displayName: string; score: number }[];
  departments: { id: string; name: string }[];
  /** The full leaf set — so an LLM resolver can pick a leaf the lexical layer
   *  missed (e.g. "vivo X300" -> Mobile Phones with no token overlap). */
  allLeaves: { nodeId: string; displayName: string; departmentId: string }[];
}

export type ResolverDecision =
  | { kind: "assign"; nodeId: string; confidence: number; reason?: string }
  | { kind: "propose_node"; parentId: string; suggestedName: string; reason?: string }
  | { kind: "abstain"; reason?: string };

/** Swappable fallback. The deterministic resolver needs no LLM (dry-run); the
 *  LLM resolver wraps a chat provider — same interface. */
export interface ClassifierResolver {
  resolve(input: ResolverInput): Promise<ResolverDecision>;
}

export type FallbackOutcome = "assign" | "propose_node" | "abstain";

export interface FallbackResult {
  outcome: FallbackOutcome;
  nodeId: string | null;
  confidence: number;
  source: "alias" | "lexical" | "resolver";
  alternatives: Candidate[];
  /** Set when outcome === "propose_node" — a draft node to create + review. */
  proposedNode?: { parentId: string; suggestedName: string };
  reason?: string;
}

export interface FallbackOptions extends ClassifyOptions {
  /** Deterministic confidence >= this auto-assigns and skips the resolver. Default 0.7. */
  autoThreshold?: number;
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
