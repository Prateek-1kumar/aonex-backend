// Aonex custom JSON Schema keywords. Both are no-ops at validation time
// (they carry metadata for downstream callers like the policy engine),
// but Ajv requires them to be declared so unknown-keyword errors don't fire.

import type Ajv from "ajv";

export function registerAonexKeywords(ajv: Ajv): void {
  ajv.addKeyword({
    keyword: "tier",
    type: "object",
    schemaType: "string",
    validate: () => true
  });

  ajv.addKeyword({
    keyword: "confidence_required",
    type: "object",
    schemaType: "object",
    validate: () => true
  });
}
