/** A JSON Schema 2019-09 document with Aonex custom keywords. */
export interface CategorySchemaInput {
  $schema?: string;
  $id?: string;
  type?: "object";
  /** "authoritative" | "inferred" | "promoted_draft" — see spec §4.4 */
  tier?: "authoritative" | "inferred" | "promoted_draft";
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: boolean | Record<string, unknown>;
  /** Aonex custom keyword: per-attribute confidence threshold for auto-approval */
  confidence_required?: Record<string, number>;
  [k: string]: unknown;
}

export type AttributesInput = Record<string, unknown>;

export interface ValidationOutcome {
  valid: boolean;
  /** Names of required keys that were absent (subset of schema.required) */
  missingRequired: string[];
  /** Type / enum / range errors */
  errors: Array<{
    path: string;          // e.g. "/capacity_persons"
    message: string;       // e.g. "must be integer"
    keyword: string;       // e.g. "type", "enum", "maximum"
  }>;
  /** Echoes the tier from the schema for the caller's routing logic */
  tier: "authoritative" | "inferred" | "promoted_draft";
}
