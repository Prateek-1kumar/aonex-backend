import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export interface CrossValidationInput {
  jsonLdFacts: ExtractedFact[];
  openGraphFacts: ExtractedFact[];
  domFacts: ExtractedFact[];
}

export interface CrossValidationResult {
  conflicts: Array<{
    field: string;
    sources: Array<{ value: unknown; source: string; confidence: number }>;
  }>;
  agreedFacts: ExtractedFact[];
}

const COMPARABLE_FIELDS = new Set([
  "base_price",
  "title",
  "brand",
  "gtin",
  "model_number"
]);

const AGREEMENT_BOOST = 0.05;
const CONFLICT_PENALTY = 0.12;

/**
 * Spec §6.1 — JSON-LD is invalid 15-30% of the time. Cross-check with
 * OpenGraph + DOM heuristics on comparable fields. On agreement, boost
 * confidence per additional concurring source. On conflict, keep the
 * highest-confidence source but apply a penalty so the policy router
 * can route to review.
 */
export function crossValidate(input: CrossValidationInput): CrossValidationResult {
  const conflicts: CrossValidationResult["conflicts"] = [];
  const agreedFacts: ExtractedFact[] = [];

  for (const field of COMPARABLE_FIELDS) {
    const sources: Array<{ value: unknown; source: string; confidence: number; fact: ExtractedFact }> = [];
    const fromJsonLd = input.jsonLdFacts.find((f) => f.rawKey === field);
    const fromOg = input.openGraphFacts.find((f) => f.rawKey === field);
    const fromDom = input.domFacts.find((f) => f.rawKey === field);
    if (fromJsonLd) sources.push({ value: fromJsonLd.extractedValue, source: "json_ld", confidence: fromJsonLd.confidence, fact: fromJsonLd });
    if (fromOg) sources.push({ value: fromOg.extractedValue, source: "opengraph", confidence: fromOg.confidence, fact: fromOg });
    if (fromDom) sources.push({ value: fromDom.extractedValue, source: "dom", confidence: fromDom.confidence, fact: fromDom });

    if (sources.length === 0) continue;

    if (sources.length === 1) {
      agreedFacts.push(sources[0]!.fact);
      continue;
    }

    const allMatch = sources.every((s) => normalize(s.value) === normalize(sources[0]!.value));
    if (allMatch) {
      const winner = sources.reduce((max, s) => (s.confidence > max.confidence ? s : max), sources[0]!);
      const boost = AGREEMENT_BOOST * (sources.length - 1);
      agreedFacts.push({
        ...winner.fact,
        confidence: Math.min(1, winner.confidence + boost)
      });
    } else {
      conflicts.push({
        field,
        sources: sources.map((s) => ({ value: s.value, source: s.source, confidence: s.confidence }))
      });
      const winner = sources.reduce((max, s) => (s.confidence > max.confidence ? s : max), sources[0]!);
      agreedFacts.push({
        ...winner.fact,
        confidence: Math.max(0, winner.confidence - CONFLICT_PENALTY)
      });
    }
  }

  // Carry forward non-comparable facts from all sources (deduplicate by rawKey + sourcePointer).
  const carried = new Set<string>();
  for (const f of [...input.jsonLdFacts, ...input.openGraphFacts, ...input.domFacts]) {
    if (COMPARABLE_FIELDS.has(f.rawKey)) continue;
    const key = `${f.rawKey}::${f.sourcePointer}`;
    if (carried.has(key)) continue;
    carried.add(key);
    agreedFacts.push(f);
  }

  return { conflicts, agreedFacts };
}

function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.trim().toLowerCase();
  return value;
}
