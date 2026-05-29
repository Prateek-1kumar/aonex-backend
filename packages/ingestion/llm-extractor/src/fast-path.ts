// Phase 3 Task 2: structured/per-site facts at/above CONFIDENT skip the LLM (T2
// cost control). The generic schema-guided extractor (Task 4) only asks for the
// fields this function returns.

export const CONFIDENT = 0.9;

export interface FactLite {
  value: unknown;
  confidence: number;
}

/** Of the schema-required fields, which ones still need the LLM?
 *  A field is "needed" when it's missing, has a nullish value, or its
 *  structured confidence is below the CONFIDENT bar. */
export function fieldsNeedingLlm(
  schemaFields: string[],
  structured: Record<string, FactLite | undefined>
): string[] {
  return schemaFields.filter((f) => {
    const fact = structured[f];
    return !fact || fact.value == null || fact.confidence < CONFIDENT;
  });
}
