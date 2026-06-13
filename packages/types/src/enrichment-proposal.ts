// The persisted per-field row of an enrichment proposal
// (enrichment_proposals.fields JSONB). One contract shared by the writer (worker)
// and the readers (API apply flow, Lab UI) so the shapes cannot drift apart.

export interface PersistedProposalField {
  /** Canonical attribute key. */
  attributeCode: string;
  /** "spec" = extracted structured attribute; "content" = synthesized
   *  description/SEO/marketing/AEO copy (review-gated, never auto-applied). */
  kind?: "spec" | "content";
  /** Content shape ("text"/"string_list"/"qa_list"/"pros_cons") — drives how the
   *  drafting room renders the value. Only set for content fields. */
  contentType?: string;
  /** attribute_definitions.enrichment_group (UI badge), when known. */
  group?: string;
  /** The product's current value at generation time (null when absent). */
  before: unknown;
  /** The proposed (validator-normalized when valid) value. */
  after: unknown;
  /** Calibrated confidence 0..1 (model × grounding × normalization). */
  confidence: number;
  reasoning?: string;
  action: "fill" | "improve";
  /** Passed validation (ok or coerced). */
  valid: boolean;
  validationError?: string;
  /** grounded | weak | inferred | unverified | contradicted. */
  grounding: string;
  /** Deterministic grounding support 0..1. */
  support: number;
  /** Source span the model cited (independently verified). */
  evidence?: string;
  /** Reason this field was flagged by the cross-field consistency pass (when it
   *  conflicts with another field). Surfaced in the review UI. */
  consistencyNote?: string;
  /** Auto-applied by the worker (source-grounded) — the API apply flow must
   *  never re-apply it. */
  accepted: boolean;
  /** Eligible for human review-then-apply. */
  proposable: boolean;
}
