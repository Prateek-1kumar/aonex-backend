// HLD §10 — Semantic Mapper pure function.
// Pipeline per HLD §10: deterministic → synonym → embedding (stub)
// → type/unit/category validation → confidence scorer.
// Pure — no DB writes. Worker orchestrates persistence at the edges.

import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { AttributeDefinition, AttributeMapping, AttributeSynonym, MappingOverride } from "@aonex/db";
import type { MappedFact, MappedFactSet, MapperCorpus } from "./types.js";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";
import { computeScore, resolveApproval } from "./pipeline/scorer.js";

export const MAPPER_VERSION = "deterministic-synonym@1.0.0";

/**
 * HLD §10 — map a fact set to canonical attribute paths.
 *
 * @param factSet - raw extracted facts from the Field Extractor
 * @param categoryPath - detected category (null if undetected)
 * @param corpus - attribute DB lookups passed as pure data by the worker
 */
export function map(
  factSet: ExtractedFactSet,
  categoryPath: string | null,
  corpus: MapperCorpus
): MappedFactSet {
  const { knownAttrs, synonyms, channelMappings, overrides } = corpus;
  const marketplace = factSet.marketplace;

  // Build fast lookup maps
  const channelMappingIndex = buildChannelMappingIndex(channelMappings, marketplace, categoryPath);
  const synonymIndex = buildSynonymIndex(synonyms);
  const attrIndex = buildAttrIndex(knownAttrs);
  const overrideIndex = buildOverrideIndex(overrides);

  const mappedFacts: MappedFact[] = factSet.facts.map((fact) =>
    mapFact(fact, categoryPath, channelMappingIndex, synonymIndex, attrIndex, overrideIndex)
  );

  return {
    original: factSet,
    facts: mappedFacts,
    mapperVersion: MAPPER_VERSION,
    categoryPath,
    mappedAt: new Date()
  };
}

// -----------------------------------------------------------------
// Per-fact mapping
// -----------------------------------------------------------------

function mapFact(
  fact: ExtractedFact,
  categoryPath: string | null,
  channelMappingIndex: Map<string, string>,
  synonymIndex: Map<string, string>,
  attrIndex: Map<string, AttributeDefinition>,
  overrideIndex: Map<string, string>
): MappedFact {
  // Skip variant-level sub-facts (handled by Variant Extractor)
  if (fact.rawKey.startsWith("variants[")) {
    return { ...fact, mappingMethod: null, mappingCandidates: null };
  }

  // Step 1: tenant override — short-circuits the pipeline.
  // Overrides are explicit user choices (HLD §10 step 1); they are ground truth,
  // not a candidate to be scored against the others. Confidence stays at the
  // extractor's confidence (the value is what's uncertain, not the mapping).
  const overrideKey = overrideIndex.get(fact.rawKey);
  if (overrideKey) {
    return {
      ...fact,
      canonicalPath: overrideKey,
      mappingMethod: "override",
      mappingCandidates: [{ key: overrideKey, score: 1.0 }],
      approved: true,
      confidence: fact.confidence
    };
  }

  const candidates: Array<{ key: string; score: number }> = [];

  // Step 2: Deterministic channel mapping (HLD §10 step 1)
  const channelKey = channelMappingIndex.get(fact.rawKey) ?? channelMappingIndex.get(fact.sourcePointer);
  if (channelKey) {
    const attr = attrIndex.get(channelKey);
    const score = computeScore({
      key: channelKey,
      channelMapping: 1.0,
      synonym: 0,
      embedding: 0,
      typeCompat: attr ? typeCompatScore(fact, attr) : 0.5,
      unitCompat: attr ? unitCompatScore(fact, attr) : 0.5,
      categoryCompat: attr ? categoryCompatScore(attr, categoryPath) : 0.5,
      tenantCorrection: 0
    });
    candidates.push({ key: channelKey, score: score.total });
  }

  // Step 3: Synonym match (HLD §10 step 2)
  const synonymKey = synonymIndex.get(fact.rawKey.toLowerCase());
  if (synonymKey && synonymKey !== channelKey) {
    const attr = attrIndex.get(synonymKey);
    const score = computeScore({
      key: synonymKey,
      channelMapping: 0,
      synonym: 1.0,
      embedding: 0,
      typeCompat: attr ? typeCompatScore(fact, attr) : 0.5,
      unitCompat: attr ? unitCompatScore(fact, attr) : 0.5,
      categoryCompat: attr ? categoryCompatScore(attr, categoryPath) : 0.5,
      tenantCorrection: 0
    });
    candidates.push({ key: synonymKey, score: score.total });
  }

  // Step 4: Embedding candidate retrieval — STUB
  // TODO: pgvector — Phase 3: query attribute_embeddings by cosine similarity.
  // const embeddingCandidates = await vectorSearch(fact.rawKey, { limit: 3 });
  const embeddingCandidates: Array<{ key: string; score: number }> = [];
  candidates.push(...embeddingCandidates);

  // Step 5: Cross-encoder rerank — STUB (Phase 3+)
  // TODO: re-rank candidates with a cross-encoder before scoring

  // Deduplicate and sort by score
  const dedupedCandidates = deduplicateCandidates(candidates);
  dedupedCandidates.sort((a, b) => b.score - a.score);

  const best = dedupedCandidates[0];

  if (!best || best.score < 0.60) {
    // Unmapped — goes into merchant_extensions_json or review queue
    return {
      ...fact,
      canonicalPath: null,
      mappingMethod: "unmapped",
      mappingCandidates: dedupedCandidates.slice(0, 3).length > 0
        ? dedupedCandidates.slice(0, 3)
        : null,
      approved: false,
      confidence: fact.confidence * (best?.score ?? 0)
    };
  }

  const { approved, mappingMethod } = resolveApproval(best.score);

  return {
    ...fact,
    canonicalPath: best.key,
    mappingMethod,
    mappingCandidates: dedupedCandidates.slice(0, 3),
    approved,
    // Combined confidence: extraction confidence × mapping confidence
    confidence: Math.min(1.0, fact.confidence * best.score)
  };
}

// -----------------------------------------------------------------
// Index builders
// -----------------------------------------------------------------

function buildChannelMappingIndex(
  mappings: AttributeMapping[],
  marketplace: string,
  categoryPath: string | null
): Map<string, string> {
  const idx = new Map<string, string>();
  for (const m of mappings) {
    if (m.marketplace === marketplace &&
        (m.categoryPath === categoryPath || m.categoryPath === "*")) {
      // sourcePath can be JSONPath ($.vendor) or plain rawKey (vendor) — support both
      idx.set(m.sourcePath, m.canonicalKey);
      // Also index the leaf key for plain rawKey lookups
      const leaf = m.sourcePath.replace(/^\$\./, "").replace(/\[.*/, "");
      idx.set(leaf, m.canonicalKey);
    }
  }
  return idx;
}

function buildSynonymIndex(synonyms: AttributeSynonym[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const s of synonyms) {
    idx.set(s.synonym.toLowerCase(), s.canonicalKey);
  }
  return idx;
}

function buildAttrIndex(attrs: AttributeDefinition[]): Map<string, AttributeDefinition> {
  return new Map(attrs.map((a) => [a.canonicalKey, a]));
}

function buildOverrideIndex(overrides: MappingOverride[]): Map<string, string> {
  // Higher priority overrides win; sort ascending so higher priority overwrites lower
  const sorted = [...overrides].sort((a, b) => a.priority - b.priority);
  const idx = new Map<string, string>();
  for (const o of sorted) {
    idx.set(o.sourceKey, o.canonicalKey);
  }
  return idx;
}

// -----------------------------------------------------------------
// Compatibility sub-scores (0..1)
// -----------------------------------------------------------------

function typeCompatScore(fact: ExtractedFact, attr: AttributeDefinition): number {
  const valueType = typeof fact.extractedValue;
  switch (attr.dataType) {
    case "string": return valueType === "string" ? 1.0 : 0.3;
    case "number": return (valueType === "number" || !isNaN(Number(fact.extractedValue))) ? 1.0 : 0.3;
    case "boolean": return valueType === "boolean" ? 1.0 : 0.3;
    case "array": return Array.isArray(fact.extractedValue) ? 1.0 : 0.3;
    case "object": return (valueType === "object" && !Array.isArray(fact.extractedValue)) ? 1.0 : 0.3;
    default: return 0.5;
  }
}

function unitCompatScore(fact: ExtractedFact, attr: AttributeDefinition): number {
  if (!attr.unitType) return 1.0; // no unit constraint
  if (!fact.unit) return 0.5;     // fact has no unit but attr expects one
  if (attr.allowedUnits.length === 0) return 1.0;
  return attr.allowedUnits.includes(fact.unit) ? 1.0 : 0.2;
}

function categoryCompatScore(attr: AttributeDefinition, categoryPath: string | null): number {
  if (attr.categoryScope.length === 0) return 1.0; // global attribute
  if (!categoryPath) return 0.5;
  return attr.categoryScope.some((scope) => categoryPath.startsWith(scope)) ? 1.0 : 0.2;
}

function deduplicateCandidates(
  candidates: Array<{ key: string; score: number }>
): Array<{ key: string; score: number }> {
  const seen = new Map<string, number>();
  for (const c of candidates) {
    const existing = seen.get(c.key);
    if (existing === undefined || c.score > existing) {
      seen.set(c.key, c.score);
    }
  }
  return Array.from(seen.entries()).map(([key, score]) => ({ key, score }));
}
