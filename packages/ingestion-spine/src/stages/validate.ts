import { validate as validateAttrs, type ValidationOutcome } from "@aonex/schema-validator";
import type { DrizzleClient } from "@aonex/db";
import type { MappedFactSet } from "@aonex/ingestion-semantic-mapper";

export interface RunValidateInput {
  db: DrizzleClient;
  mappedFactSet: MappedFactSet;
}

export interface ValidateStageResult extends ValidationOutcome {
  /** Attributes object that was validated (post-mapping) */
  attributes: Record<string, unknown>;
  /** Resolved category schema version (or null when Tier 2 / no schema) */
  categorySchemaVersion: string | null;
  /** Echoed for downstream stages */
  categoryPath: string | null;
}

export async function runValidate(input: RunValidateInput): Promise<ValidateStageResult> {
  const categoryPath = input.mappedFactSet.categoryPath;

  // Materialize attributes_json from mapped facts (skip variant sub-facts).
  const attributes: Record<string, unknown> = {};
  for (const fact of input.mappedFactSet.facts) {
    if (!fact.canonicalPath) continue;
    if (fact.canonicalPath.startsWith("variants[")) continue;
    attributes[fact.canonicalPath] = fact.normalizedValue ?? fact.extractedValue;
  }

  if (!categoryPath) {
    return {
      valid: true,
      missingRequired: [],
      errors: [],
      tier: "inferred",
      attributes,
      categorySchemaVersion: null,
      categoryPath: null
    };
  }

  const schemaRow = await input.db.query.categorySchemas.findFirst({
    where: (c, { eq }) => eq(c.categoryPath, categoryPath),
    orderBy: (c, { desc }) => [desc(c.schemaVersion)]
  });

  if (!schemaRow) {
    return {
      valid: true,
      missingRequired: [],
      errors: [],
      tier: "inferred",
      attributes,
      categorySchemaVersion: null,
      categoryPath
    };
  }

  // Tier 2 inferred categories: permissive — pass without validation.
  if (schemaRow.tier !== "authoritative") {
    return {
      valid: true,
      missingRequired: [],
      errors: [],
      tier: schemaRow.tier as "inferred" | "promoted_draft",
      attributes,
      categorySchemaVersion: `${categoryPath}/v${schemaRow.schemaVersion}`,
      categoryPath
    };
  }

  // Tier 1 strict
  const outcome = validateAttrs(schemaRow.jsonSchema as Record<string, unknown>, attributes);
  return {
    ...outcome,
    attributes,
    categorySchemaVersion: `${categoryPath}/v${schemaRow.schemaVersion}`,
    categoryPath
  };
}
