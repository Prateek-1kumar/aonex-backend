// packages/archetypes/src/completeness.ts
import type { Archetype, CompletenessResult } from "./types.js";

export interface ScoreOptions { threshold: number; identifierExists: boolean; }

/** Hard anti-garbage floor (spec B2): a title, and either a present identifier
 *  or an explicit identifier_exists=false escape hatch. */
export function hardFloorOk(present: Set<string>, identifierExists: boolean): boolean {
  if (!present.has("title")) return false;
  if (!identifierExists) return true;            // legitimately ID-less goods
  return present.has("identifier") || present.has("gtin") || present.has("mpn");
}

/** Weighted required-coverage for an archetype. */
export function scoreCompleteness(
  arch: Archetype, present: Set<string>, opts: ScoreOptions
): CompletenessResult {
  const required = arch.attributes.filter((a) => a.tier === "required");
  const recommended = arch.attributes.filter((a) => a.tier === "recommended");
  const totalW = required.reduce((s, a) => s + a.weight, 0);
  const presentW = required.filter((a) => present.has(a.field)).reduce((s, a) => s + a.weight, 0);
  const score = totalW === 0 ? 1 : presentW / totalW;
  const missingRequired = required.filter((a) => !present.has(a.field))
    .sort((x, y) => y.weight - x.weight).map((a) => a.field);
  const missingRecommended = recommended.filter((a) => !present.has(a.field)).map((a) => a.field);
  return {
    score, meetsThreshold: score >= opts.threshold,
    missingRequired, missingRecommended,
    hardFloorOk: hardFloorOk(present, opts.identifierExists),
  };
}
