// Phase 3 Task 1: turn an archetype into a JSON schema the model fills.
// Required + recommended attributes are requested; only required ones are marked
// required. Optional attributes are dropped (don't make the model think they're
// always worth fetching — spec T2 cost control).

import type { Archetype } from "@aonex/archetypes";

export interface ExtractionSchema {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

/** Field-name → JSON type. Defaults to "string" when not listed. */
const NUMERIC = new Set(["base_price", "ram", "storage_gb"]);

export function schemaFromArchetype(arch: Archetype): ExtractionSchema {
  const properties: ExtractionSchema["properties"] = {};
  const required: string[] = [];
  for (const a of arch.attributes) {
    if (a.tier === "optional") continue;
    properties[a.field] = {
      type: NUMERIC.has(a.field) ? "number" : "string",
      description: `${arch.label} ${a.field}`,
    };
    if (a.tier === "required") required.push(a.field);
  }
  return { type: "object", properties, required };
}
