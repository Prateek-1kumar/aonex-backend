// Dynamic enrichment schema resolver.
//
// resolveActiveSchema(product signals) = the archetype's attribute spec  ∪  the
// universal groups (marketing/seo/aeo/category/core), each JOINED to its typed
// definition in the attribute catalogue, with PROTECTED commerce facts filtered out.
//
// This is what makes "which fields to enrich" dynamic per product type:
//   jeans -> fit/fabric/rise + universal, no storage
//   phone -> storage/ram/battery + universal, no fabric
//
// Pure: callers (the enrichment service) may inject DB-hydrated specs so a
// human-accepted, runtime-discovered attribute extends the schema (self-extension).

import type { AttributeSpec, AttributeTier } from "./types.js";
import { classifyArchetype, type ClassifySignals } from "./classify.js";
import { getArchetype } from "./registry.js";
import {
  type AttrDataType,
  type EnrichmentGroup,
  PROTECTED_KEYS,
  UNIVERSAL_ATTRS,
  lookupAttrDef,
} from "./seed/attribute-catalog.js";

export interface ResolvedField {
  key: string;
  label: string;
  group: EnrichmentGroup;
  dataType: AttrDataType;
  tier: AttributeTier;
  weight: number;
  enumValues?: string[];
  unitType?: string;
  /** Per-field guidance (length limits, format hints) surfaced to the LLM prompt. */
  description?: string;
}

export interface ActiveSchema {
  archetypeId: string;
  /** True when classification abstained and we fell back to the generic archetype. */
  fellBackToGeneric: boolean;
  /** Enrichable, typed fields the LLM should be asked to fill (protected facts excluded). */
  fields: ResolvedField[];
}

export interface ResolveOptions {
  /** Override an archetype's specs (e.g. DB-hydrated + self-extended). Keyed by archetype id. */
  specsByArchetype?: Record<string, AttributeSpec[]>;
  /** Archetype to use when classification returns "unknown". Default "generic". */
  fallbackArchetype?: string;
}

const GROUP_ORDER: Record<EnrichmentGroup, number> = {
  core: 0, descriptive: 1, occasion: 2, care: 3, marketing: 4, seo: 5, aeo: 6, category: 7,
};

/** Resolve the dynamic, typed enrichment field set for a product. */
export function resolveActiveSchema(
  signals: ClassifySignals,
  opts: ResolveOptions = {}
): ActiveSchema {
  const fallback = opts.fallbackArchetype ?? "generic";
  const classified = classifyArchetype(signals);
  const fellBackToGeneric = classified === "unknown";
  const archetypeId = fellBackToGeneric ? fallback : classified;

  const specs: AttributeSpec[] =
    opts.specsByArchetype?.[archetypeId] ?? getArchetype(archetypeId)?.attributes ?? [];
  const specByField = new Map(specs.map((s) => [s.field, s]));

  // Union of the archetype's spec fields and every universal attribute key.
  const keys = new Set<string>([
    ...specs.map((s) => s.field),
    ...UNIVERSAL_ATTRS.map((d) => d.key),
  ]);

  const fields: ResolvedField[] = [];
  for (const key of keys) {
    if (PROTECTED_KEYS.has(key)) continue; // never enrich commerce facts
    const def = lookupAttrDef(key);
    if (!def) continue; // not in the catalogue => not enrichable
    const spec = specByField.get(key);
    const field: ResolvedField = {
      key,
      label: def.label,
      group: def.group,
      dataType: def.dataType,
      tier: spec?.tier ?? "recommended",
      weight: spec?.weight ?? 0.4,
    };
    if (def.enumValues) field.enumValues = def.enumValues;
    if (def.unitType) field.unitType = def.unitType;
    if (def.description) field.description = def.description;
    fields.push(field);
  }

  fields.sort((a, b) =>
    GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || b.weight - a.weight || a.key.localeCompare(b.key)
  );

  return { archetypeId, fellBackToGeneric, fields };
}
