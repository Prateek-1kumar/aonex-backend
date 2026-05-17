import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput, StructuredResult } from "./types.js";

type ParserKind = ParserOutput["kind"];
type FieldFamily =
  | "identifier"
  | "price"
  | "inventory"
  | "variants"
  | "attribute"
  | "category"
  | "text";

// Field-level precedence ranks: higher = more authoritative for that field
// family. Ranks (not raw confidences) are used to pick a winner across parsers
// — this prevents JSON-LD's blanket 0.95 baseline from beating NEXT_DATA on
// fields where NEXT_DATA is more trustworthy (inventory, category) while
// preserving JSON-LD's win on canonical attributes (material, title).
const PRECEDENCE: Record<FieldFamily, Partial<Record<ParserKind, number>>> = {
  identifier: { json_ld: 5, shopify_probe: 5, next_data: 4, microdata: 3, nuxt: 3, initial_state: 3, magento: 3, woocommerce: 2, algolia: 2, opengraph: 1 },
  price:      { json_ld: 5, shopify_probe: 5, next_data: 4, microdata: 3, nuxt: 3, initial_state: 3, magento: 3, woocommerce: 2, algolia: 2, opengraph: 2 },
  inventory:  { shopify_probe: 5, next_data: 5, json_ld: 1, microdata: 1, nuxt: 1, initial_state: 1, magento: 1, woocommerce: 1, algolia: 0, opengraph: 0 },
  variants:   { shopify_probe: 5, next_data: 5, json_ld: 4, microdata: 2, nuxt: 2, initial_state: 2, magento: 1, woocommerce: 1, algolia: 0, opengraph: 0 },
  attribute:  { json_ld: 5, microdata: 3, next_data: 3, shopify_probe: 2, nuxt: 2, initial_state: 2, magento: 2, woocommerce: 1, algolia: 1, opengraph: 1 },
  category:   { next_data: 5, microdata: 3, json_ld: 3, shopify_probe: 2, nuxt: 2, initial_state: 2, magento: 2, woocommerce: 1, algolia: 1, opengraph: 1 },
  text:       { json_ld: 5, shopify_probe: 5, next_data: 4, microdata: 3, nuxt: 3, initial_state: 3, magento: 3, woocommerce: 2, algolia: 2, opengraph: 2 },
};

const CORE_IDENTIFIER_KEYS = new Set(["gtin", "sku", "mpn", "model_number", "barcode"]);
const CORE_PRICE_KEYS = new Set(["base_price", "currency", "mrp"]);
const CORE_TEXT_KEYS = new Set(["title", "description", "brand", "images"]);

function fieldFamily(rawKey: string): FieldFamily {
  if (/^variants\[\d+\]\.inventory_quantity$/.test(rawKey)) return "inventory";
  if (/^variants\[\d+\]\.price$/.test(rawKey)) return "price";
  if (/^variants\[\d+\]/.test(rawKey)) return "variants";
  if (CORE_IDENTIFIER_KEYS.has(rawKey)) return "identifier";
  if (CORE_PRICE_KEYS.has(rawKey)) return "price";
  if (rawKey === "productType") return "category";
  if (CORE_TEXT_KEYS.has(rawKey)) return "text";
  // Everything else (color, material, weight, gender, rating, additionalProperty slugs)
  return "attribute";
}

function rank(kind: ParserKind, rawKey: string): number {
  const family = fieldFamily(rawKey);
  return PRECEDENCE[family]?.[kind] ?? 0;
}

type Candidate = { fact: ExtractedFact; kind: ParserKind };

export function mergeParserOutputs(outputs: ParserOutput[]): StructuredResult {
  const byKey = new Map<string, { winner: Candidate; alts: Candidate[] }>();
  for (const out of outputs) {
    for (const fact of out.facts) {
      const candidate: Candidate = { fact, kind: out.kind };
      const slot = byKey.get(fact.rawKey);
      if (!slot) {
        byKey.set(fact.rawKey, { winner: candidate, alts: [] });
        continue;
      }
      const winnerRank = rank(slot.winner.kind, fact.rawKey);
      const candidateRank = rank(candidate.kind, fact.rawKey);
      if (candidateRank > winnerRank) {
        slot.alts.push(slot.winner);
        slot.winner = candidate;
      } else if (
        candidateRank === winnerRank &&
        fact.confidence > slot.winner.fact.confidence
      ) {
        // Same field-level rank — fall back to raw confidence.
        slot.alts.push(slot.winner);
        slot.winner = candidate;
      } else {
        slot.alts.push(candidate);
      }
    }
  }

  const facts: ExtractedFact[] = [];
  for (const { winner, alts } of byKey.values()) {
    const sourceAlternatives = alts
      .filter((c) => !sameValue(c.fact.extractedValue, winner.fact.extractedValue))
      .map((c) => ({
        value: c.fact.extractedValue,
        sourcePointer: c.fact.sourcePointer,
        confidence: c.fact.confidence,
      }));
    facts.push({
      ...winner.fact,
      sourceAlternatives: sourceAlternatives.length > 0 ? sourceAlternatives : null,
    });
  }

  const cat = facts.find((f) => f.rawKey === "productType");
  const byParser: StructuredResult["byParser"] = {
    json_ld: outputs.find((o) => o.kind === "json_ld") ?? null,
    shopify_probe: outputs.find((o) => o.kind === "shopify_probe") ?? null,
    next_data: outputs.find((o) => o.kind === "next_data") ?? null,
    microdata: outputs.find((o) => o.kind === "microdata") ?? null,
    opengraph: outputs.find((o) => o.kind === "opengraph") ?? null,
    nuxt: outputs.find((o) => o.kind === "nuxt") ?? null,
    initial_state: outputs.find((o) => o.kind === "initial_state") ?? null,
    magento: outputs.find((o) => o.kind === "magento") ?? null,
    woocommerce: outputs.find((o) => o.kind === "woocommerce") ?? null,
    algolia: outputs.find((o) => o.kind === "algolia") ?? null,
  };

  return {
    facts,
    byParser,
    category: cat
      ? { path: String(cat.extractedValue), confidence: cat.confidence }
      : { path: null, confidence: 0 },
  };
}

// Loose equality used to decide whether an alt is a real conflict vs. the same
// value emitted by multiple parsers. Strings are compared case-insensitively
// and trimmed; numbers compare with tolerance; everything else falls back to
// JSON equality (sufficient for primitive payloads in extracted_facts).
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-6;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
