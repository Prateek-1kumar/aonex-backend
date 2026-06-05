// In-memory registry of archetype definitions for @aonex/archetypes.
//
// registerArchetype/getArchetype/listArchetypes wrap a Map keyed by archetype
// id; the seeds are registered at module load. With catalog enrichment this is a
// cache of the code seeds; Phase 1 hydrates runtime-discovered specs from
// archetype_attribute_specs (DB) on top of these.

import type { Archetype } from "./types.js";
import { smartphone } from "./seed/smartphone.js";
import { apparel } from "./seed/apparel.js";
import { furniture } from "./seed/furniture.js";
import { beauty } from "./seed/beauty.js";
import { generic } from "./seed/generic.js";

const REGISTRY = new Map<string, Archetype>();

export function registerArchetype(a: Archetype): void { REGISTRY.set(a.id, a); }
export function getArchetype(id: string): Archetype | undefined { return REGISTRY.get(id); }
export function listArchetypes(): Archetype[] { return [...REGISTRY.values()]; }

// Seeds (v1 verticals + generic fallback).
registerArchetype(smartphone);
registerArchetype(apparel);
registerArchetype(furniture);
registerArchetype(beauty);
registerArchetype(generic);
