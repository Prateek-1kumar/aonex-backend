import Ajv2019, { type ErrorObject } from "ajv/dist/2019.js";
import addFormats from "ajv-formats";
import { registerAonexKeywords } from "./aonex-keywords.js";
import type {
  CategorySchemaInput,
  AttributesInput,
  ValidationOutcome
} from "./types.js";

const ajv = new Ajv2019({
  strict: false,
  allErrors: true,
  removeAdditional: false,
  useDefaults: false,
  coerceTypes: false
});

addFormats(ajv);
registerAonexKeywords(ajv);

/**
 * Validate an attributes_json object against a category JSON Schema 2019-09.
 */
export function validate(
  schema: CategorySchemaInput,
  attrs: AttributesInput
): ValidationOutcome {
  const validateFn = ajv.compile(schema);
  const valid = validateFn(attrs) as boolean;
  const errors = validateFn.errors ?? [];

  const missingRequired: string[] = [];
  const otherErrors: ValidationOutcome["errors"] = [];

  for (const err of errors as ErrorObject[]) {
    if (err.keyword === "required") {
      const missing = (err.params as { missingProperty?: string }).missingProperty;
      if (missing) missingRequired.push(missing);
    } else {
      otherErrors.push({
        path: err.instancePath || "/",
        message: err.message ?? "validation error",
        keyword: err.keyword
      });
    }
  }

  return {
    valid: missingRequired.length === 0 && otherErrors.length === 0,
    missingRequired,
    errors: otherErrors,
    tier: schema.tier ?? "authoritative"
  };
}
