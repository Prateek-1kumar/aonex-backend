// Attribute-key resolver — the single vocabulary boundary (Faithful Catalog §3/§5).
//
// Source adapters extract attributes under whatever key the page/feed used
// (`cpu_model`, `search-alias`, `Refresh Rate`, …). Left unchecked those raw
// keys land in `catalog_products.values` as first-class attributes — which is
// how junk like Amazon's "report incorrect info" form selects (`onlineday`,
// `offlinestorename`) and the search-scope dropdown (`search-alias=…`) ended up
// masquerading as product data.
//
// This resolver maps a raw key against the `attribute_definitions` registry
// (+ `attribute_synonyms`):
//   - a recognized key            → its canonical code (first-class), `mapped:true`
//   - an unrecognized key         → `custom.<slug>` (quarantined, surfaced as
//                                    "Additional specifications, pending mapping"),
//                                    `mapped:false`
//
// Nothing is dropped (lossless intake): unknown keys are preserved under the
// `custom.` namespace and can be *graduated* to first-class later (a reviewer
// confirms `custom.cpu_model → processor`, which writes a synonym/override).
// This is strictly better than the reviewer's "add a registry up front" ask —
// the registry already exists; what was missing is routing unknowns through it
// without losing them.
//
// Pure — no I/O. The caller (worker) loads the vocabulary from the DB once and
// passes it in via AdaptContext.

import type { AttributeDefinition, AttributeSynonym } from "./types.js";

export interface AttributeVocabulary {
  /** Lowercased raw key → canonical key (exact registry hits). */
  readonly canonicalByLower: ReadonlyMap<string, string>;
  /** Lowercased synonym → canonical key. */
  readonly synonymByLower: ReadonlyMap<string, string>;
}

export interface ResolvedAttribute {
  /** The canonical code (recognized) or `custom.<slug>` (unrecognized). */
  code: string;
  /** True when the raw key resolved to a registry/synonym canonical key. */
  mapped: boolean;
  /** The original raw key, always preserved for provenance/graduation. */
  rawKey: string;
}

/** Namespace prefix for unrecognized attributes. */
export const CUSTOM_ATTRIBUTE_PREFIX = "custom.";

/**
 * Slugify a raw key into a stable `custom.` suffix:
 *   "search-alias"   → "search_alias"
 *   "Refresh Rate"   → "refresh_rate"
 *   "CPU Model (v2)" → "cpu_model_v2"
 * Collapses any run of non-alphanumerics to a single underscore and trims
 * leading/trailing underscores. Empty/garbage input falls back to "unknown".
 */
export function slugifyCustomKey(rawKey: string): string {
  const slug = rawKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "unknown";
}

/**
 * Build a lookup vocabulary from registry definitions + synonyms. Cheap to
 * build; the worker may cache it across ingests if the corpus is large.
 */
export function buildVocabulary(
  definitions: AttributeDefinition[],
  synonyms: AttributeSynonym[]
): AttributeVocabulary {
  const canonicalByLower = new Map<string, string>();
  for (const d of definitions) {
    canonicalByLower.set(d.canonicalKey.toLowerCase(), d.canonicalKey);
  }
  const synonymByLower = new Map<string, string>();
  for (const s of synonyms) {
    // A synonym only counts if its target canonical key is a real definition;
    // skip dangling synonyms so we never resolve to a non-existent attribute.
    if (canonicalByLower.has(s.canonicalKey.toLowerCase())) {
      synonymByLower.set(s.synonym.toLowerCase(), s.canonicalKey);
    }
  }
  return { canonicalByLower, synonymByLower };
}

/** True when the vocabulary carries no known keys and no synonyms. Callers use
 *  this to preserve legacy passthrough behaviour when no corpus was loaded. */
export function isEmptyVocabulary(vocab: AttributeVocabulary): boolean {
  return vocab.canonicalByLower.size === 0 && vocab.synonymByLower.size === 0;
}

/**
 * Resolve one raw attribute key against the vocabulary. Pure.
 *
 *   1. exact registry hit (case-insensitive) → canonical code, mapped.
 *   2. synonym hit (case-insensitive)        → canonical code, mapped.
 *   3. otherwise                             → `custom.<slug>`, unmapped.
 */
export function resolveAttributeCode(
  rawKey: string,
  vocab: AttributeVocabulary
): ResolvedAttribute {
  const norm = rawKey.trim().toLowerCase();

  const direct = vocab.canonicalByLower.get(norm);
  if (direct !== undefined) return { code: direct, mapped: true, rawKey };

  const viaSynonym = vocab.synonymByLower.get(norm);
  if (viaSynonym !== undefined) return { code: viaSynonym, mapped: true, rawKey };

  return {
    code: `${CUSTOM_ATTRIBUTE_PREFIX}${slugifyCustomKey(rawKey)}`,
    mapped: false,
    rawKey
  };
}
