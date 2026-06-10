// Taxonomy validator — public contracts.
//
// The validator checks/normalizes a product's attribute values against a leaf's
// schema (the node_attributes + attribute_definitions for that taxonomy node).
// Its real job is NORMALIZE, not just accept/reject: fuzzy enum coercion, unit
// parsing, range checks, tiered completeness, and structured per-field outcomes.

export type Tier = "required" | "recommended" | "optional";
export type AttrDataType = "string" | "number" | "boolean" | "array";

/** One attribute's rule, resolved from node_attributes + attribute_definitions. */
export interface AttributeSpec {
  key: string;
  tier: Tier;
  /** Default "string". "array" = multi-value (each element enum-coerced). */
  dataType?: AttrDataType;
  /** Allowed values; inputs are exact -> case-insensitive -> fuzzy coerced. */
  enumValues?: string[];
  /** Canonical unit (e.g. "g", "GB"); inputs in allowedUnits convert to it. */
  unit?: string;
  allowedUnits?: string[];
  min?: number;
  max?: number;
}

export interface LeafSchema {
  nodeId: string;
  attributes: AttributeSpec[];
}

export type FieldStatus =
  | "ok" // present and valid as-is
  | "coerced" // present, normalized to a valid value (case/fuzzy/unit)
  | "invalid" // present but cannot be made valid
  | "missing"; // absent

export interface FieldOutcome {
  key: string;
  tier: Tier;
  status: FieldStatus;
  /** Original input value (absent when status === "missing"). */
  value?: unknown;
  /** Normalized value to persist (when ok/coerced). */
  normalized?: unknown;
  /** Nearest allowed value, when invalid against an enum. */
  suggestion?: string;
  message?: string;
}

export interface Completeness {
  required: number; // 0..1 coverage within tier
  recommended: number;
  optional: number;
  /** Tier-weighted 0..100 (required dominates; empty tiers dropped). */
  score: number;
}

export interface ValidationResult {
  nodeId: string;
  fields: FieldOutcome[];
  completeness: Completeness;
  missingRequired: string[];
  /** Count of fields with status "invalid". */
  violations: number;
}
