// @aonex/taxonomy-validator — validate + normalize product attributes against a
// taxonomy leaf schema. See validate.ts for the entry point.

export { validateAttributes } from "./validate.js";
export { coerceEnum, parseUnit, editDistance } from "./normalize.js";
export type {
  AttributeSpec,
  LeafSchema,
  Tier,
  AttrDataType,
  FieldStatus,
  FieldOutcome,
  Completeness,
  ValidationResult,
} from "./types.js";
