# @aonex/schema-validator

Validates a product's `attributes_json` object against a category-specific JSON Schema 2019-09 document, including custom Aonex keywords.

## Exports

- `validate(schema, attrs)` — returns `ValidationOutcome`: `{ valid, missingRequired, errors, tier }`
- `CategorySchemaInput` — schema shape including custom keywords `tier` and `confidence_required`
- `AttributesInput` — `Record<string, unknown>`
- `ValidationOutcome` — structured result with missing required fields and typed error list

Custom Ajv keywords registered: `tier` (schema quality level) and `confidence_required` (per-attribute confidence thresholds for the policy engine).

## How it fits

Used by `packages/catalog/catalog-service` (validates attributes before canonical write) and `packages/ingestion-spine` (validates extracted attributes before persistence).

## Dependencies

None (`@aonex/*`-free; uses `ajv` and `ajv-formats`).
