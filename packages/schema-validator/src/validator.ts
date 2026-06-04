// Canonical schema validator — `validate()`, the package's only runtime export.
//
// Compiles a category JSON Schema 2019-09 (with Aonex custom keywords) via a
// module-level Ajv instance and checks an attributes_json object against it,
// splitting results into missingRequired vs typed errors and echoing the
// schema tier for the caller's routing logic. Schemas are cached by `$id`.

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
 *
 * Schemas are cached by `$id` inside the module-level Ajv instance — pass a
 * stable schema object per `$id`. Mutating a schema between calls without
 * changing its `$id` will return the cached (stale) validator.
 */
export function validate(
  schema: CategorySchemaInput,
  attrs: AttributesInput
): ValidationOutcome {
  const validateFn = ajv.compile(schema);
  validateFn(attrs); // populates validateFn.errors; boolean result unused
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
