// In-memory registry of archetype definitions for @aonex/archetypes.
//
// registerArchetype/getArchetype/listArchetypes wrap a Map keyed by archetype
// id; the seeds are registered at module load. With catalog enrichment this is a
// cache of the code seeds; Phase 1 hydrates runtime-discovered specs from
// archetype_attribute_specs (DB) on top of these.

import type { Archetype } from "./types.js";
import { universalSpecs } from "./seed/attribute-catalog.js";
import { smartphone } from "./seed/smartphone.js";
import { apparel } from "./seed/apparel.js";
import { furniture } from "./seed/furniture.js";
import { beauty } from "./seed/beauty.js";
import { generic } from "./seed/generic.js";

const REGISTRY = new Map<string, Archetype>();

export function registerArchetype(a: Archetype): void { REGISTRY.set(a.id, a); }
export function getArchetype(id: string): Archetype | undefined { return REGISTRY.get(id); }
export function listArchetypes(): Archetype[] { return [...REGISTRY.values()]; }

/** Merge the universal content/SEO/marketing/AEO/category specs into an archetype
 *  so the whole content schema is SCORED. The archetype's own spec wins on key
 *  conflicts (e.g. its tuned category_path / description_long weights). */
function withUniversalSpecs(a: Archetype): Archetype {
  const seen = new Set(a.attributes.map((s) => s.field));
  const merged = [...a.attributes, ...universalSpecs().filter((s) => !seen.has(s.field))];
  return { ...a, attributes: merged };
}

// Seeds (v1 verticals + generic fallback), each scored over the full content schema.
registerArchetype(withUniversalSpecs(smartphone));
registerArchetype(withUniversalSpecs(apparel));
registerArchetype(withUniversalSpecs(furniture));
registerArchetype(withUniversalSpecs(beauty));
registerArchetype(withUniversalSpecs(generic));
