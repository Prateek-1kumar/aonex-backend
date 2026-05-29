// Phase 3 Task 4: one-pass, schema-guided extraction.
//
// Given an archetype + already-known structured facts + cleaned page text,
// build a JSON schema, decide which fields the fast-path didn't already cover,
// ask the injected model once, and calibrate the returned confidences via the
// isotonic model. Returns ONLY the LLM-derived facts; the caller merges them
// with the structured ones.

import type { Archetype } from "@aonex/archetypes";
import type { IsotonicModel } from "@aonex/calibration";
import { schemaFromArchetype } from "./schema-from-archetype.js";
import { fieldsNeedingLlm, type FactLite } from "./fast-path.js";
import { calibrateFacts, type CalibratedFact, type RawFact } from "./calibrate-confidence.js";

export interface GenericExtractInput {
  archetype: Archetype;
  structured: Record<string, FactLite | undefined>;
  cleanedText: string;
  calibration: IsotonicModel;
  /** Injected — LLM or vision adapter. Returns raw confidences keyed by field.
   *  May return fewer fields than asked (the model doesn't know everything). */
  callModel: (
    schemaFields: string[],
    cleanedText: string
  ) => Promise<Record<string, { value: unknown; rawConfidence: number }>>;
}

export async function genericExtract(input: GenericExtractInput): Promise<CalibratedFact[]> {
  const schema = schemaFromArchetype(input.archetype);
  const need = fieldsNeedingLlm(Object.keys(schema.properties), input.structured);
  if (need.length === 0) return [];

  const raw = await input.callModel(need, input.cleanedText);
  const rawFacts: RawFact[] = Object.entries(raw)
    .filter(([f]) => need.includes(f))
    .map(([field, v]) => ({ field, value: v.value, rawConfidence: v.rawConfidence }));
  return calibrateFacts(rawFacts, input.calibration);
}
