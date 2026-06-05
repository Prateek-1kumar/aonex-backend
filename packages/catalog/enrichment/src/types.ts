// Catalog enrichment — proposal contracts (review-then-apply, spec §4).
//
// generateEnrichmentProposal() returns an EnrichmentProposal: a per-field
// before->after diff plus discovered candidate attributes. NOTHING is written to
// the catalog here — the API "apply" step turns accepted fields into observations
// and accepted candidates into registered attributes.

import type { AttrDataType, EnrichmentGroup } from "@aonex/archetypes";

export type FieldAction = "fill" | "improve" | "new";
export type FieldDecision = "pending" | "accept" | "reject" | "edit";
export type CandidateDecision = "pending" | "accept" | "reject";

export interface ProposalField {
  attributeCode: string;
  group: EnrichmentGroup;
  /** Current reconciled value (for the diff). null when the field was empty. */
  before: unknown | null;
  /** Proposed value from the model. */
  after: unknown;
  confidence: number; // 0..1
  reasoning?: string; // per-field "why" (provenance)
  action: FieldAction;
  /** false when the value failed enum/type validation — flagged, not dropped. */
  valid: boolean;
  validationError?: string;
  decision: FieldDecision;
  editedValue?: unknown;
}

/** A type-relevant attribute the model surfaced that is NOT yet in the schema.
 *  Accepting it (in review) registers it into attribute_definitions + the
 *  archetype schema — this is the self-extension loop (spec §2.3). */
export interface CandidateAttribute {
  key: string;
  label: string;
  group: EnrichmentGroup;
  dataType: AttrDataType;
  value: unknown;
  unit?: string;
  enumCandidates?: string[];
  reasoning: string;
  decision: CandidateDecision;
}

export interface ScoreSnapshot {
  /** Archetype-weighted completeness, 0..100. */
  completeness: number;
}

export interface EnrichmentProposal {
  productId: string;
  archetype: string;
  fellBackToGeneric: boolean;
  model: string;
  promptVersion: string;
  fields: ProposalField[];
  candidates: CandidateAttribute[];
  scoreBefore: ScoreSnapshot;
  /** Projected score if every valid field were accepted. */
  scoreAfter: ScoreSnapshot;
  /** Top-level model reasoning trace (DeepSeek reasoning_content), if any. */
  reasoning?: string;
  costUsd: number;
  usage: { promptTokens: number; completionTokens: number };
}

/** What the worker loads from the catalog and hands to the engine. Keeps this
 *  package DB-agnostic — the 4-axis winning_values are pre-flattened to a simple
 *  attributeCode -> display value map by the caller. */
export interface ProductSnapshot {
  productId: string;
  family: string | null;
  /** Reconciled display values, attributeCode -> value (used for grounding + diff). */
  current: Record<string, unknown>;
  /** Presence of protected commerce facts, for completeness scoring. */
  facts: {
    hasPrice: boolean;
    hasCurrency: boolean;
    hasIdentifier: boolean;
    hasTitle: boolean;
  };
  title?: string;
  categoryPath?: string;
  brand?: string;
}
