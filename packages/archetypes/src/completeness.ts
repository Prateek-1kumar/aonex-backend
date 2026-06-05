// packages/archetypes/src/completeness.ts
import type { Archetype, AttributeSpec, AttributeTier, CompletenessResult } from "./types.js";
import { PROTECTED_KEYS, universalSpecs } from "./seed/attribute-catalog.js";

/** Protected commerce facts (price/currency/identifier) are owned elsewhere and
 *  enrichment is forbidden to fill them — so the CONTENT completeness score
 *  discounts them, letting enrichment drive the number up. Only scoreCompletenessPercent
 *  (catalog ring + enrich delta) applies this; the admission gate (scoreCompleteness)
 *  still treats commerce facts at full weight. */
const PROTECTED_WEIGHT_FACTOR = 0.2;
function scoredWeight(a: AttributeSpec): number {
  return PROTECTED_KEYS.has(a.field) ? a.weight * PROTECTED_WEIGHT_FACTOR : a.weight;
}

/** The content-completeness schema: the archetype's own specs UNIONED with the
 *  universal content/SEO/marketing/AEO/category specs (archetype wins on conflict).
 *  Kept out of the registry so ingestion gap-fill + the gate stay lean — only the
 *  catalog/enrich score (scoreCompletenessPercent) measures the full content schema. */
function scoredSchema(arch: Archetype): AttributeSpec[] {
  const seen = new Set(arch.attributes.map((s) => s.field));
  return [...arch.attributes, ...universalSpecs().filter((s) => !seen.has(s.field))];
}

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

export interface TierCoverage { presentWeight: number; totalWeight: number; percent: number; }
export interface CompletenessPercent {
  /** 0..100, server-authoritative quality score for the catalog ring + enrich delta. */
  percent: number;
  byTier: Record<AttributeTier, TierCoverage>;
}

const TIER_SHARE: Record<AttributeTier, number> = {
  required: 0.7,
  recommended: 0.25,
  optional: 0.05,
};

/** A fuller 0..100 score than scoreCompleteness: weighted coverage across all three
 *  tiers (required dominates, recommended/optional add partial credit). Drives the
 *  "Needs Enrichment" tab and the before/after enrich delta. Tiers with no attributes
 *  are dropped from the denominator so the blend stays fair across archetypes. */
export function scoreCompletenessPercent(
  arch: Archetype, present: Set<string>
): CompletenessPercent {
  const tiers: AttributeTier[] = ["required", "recommended", "optional"];
  const byTier = {} as Record<AttributeTier, TierCoverage>;
  const schema = scoredSchema(arch);
  let weightedGot = 0;
  let weightedTotal = 0;
  for (const tier of tiers) {
    const attrs = schema.filter((a) => a.tier === tier);
    const totalWeight = attrs.reduce((s, a) => s + scoredWeight(a), 0);
    const presentWeight = attrs
      .filter((a) => present.has(a.field))
      .reduce((s, a) => s + scoredWeight(a), 0);
    const coverage = totalWeight === 0 ? 0 : presentWeight / totalWeight;
    byTier[tier] = {
      presentWeight: Math.round(presentWeight * 1000) / 1000,
      totalWeight: Math.round(totalWeight * 1000) / 1000,
      percent: Math.round(coverage * 10000) / 100,
    };
    if (totalWeight > 0) {
      weightedTotal += TIER_SHARE[tier];
      weightedGot += TIER_SHARE[tier] * coverage;
    }
  }
  const percent = weightedTotal === 0 ? 100 : Math.round((weightedGot / weightedTotal) * 10000) / 100;
  return { percent, byTier };
}
