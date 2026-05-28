import type { Archetype } from "./types.js";
import { smartphone } from "./seed/smartphone.js";

const REGISTRY = new Map<string, Archetype>();

export function registerArchetype(a: Archetype): void { REGISTRY.set(a.id, a); }
export function getArchetype(id: string): Archetype | undefined { return REGISTRY.get(id); }
export function listArchetypes(): Archetype[] { return [...REGISTRY.values()]; }

registerArchetype(smartphone); // v1 vertical
