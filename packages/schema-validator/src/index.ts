// Public barrel for @aonex/schema-validator.
//
// Re-exports `validate` plus the CategorySchemaInput / AttributesInput /
// ValidationOutcome types — the package's whole surface for callers that check
// an extracted/canonical product against its category schema.

export { validate } from "./validator.js";
export type { CategorySchemaInput, AttributesInput, ValidationOutcome } from "./types.js";
