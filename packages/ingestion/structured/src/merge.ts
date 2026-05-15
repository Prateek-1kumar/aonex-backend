import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput, StructuredResult } from "./types.js";

export function mergeParserOutputs(outputs: ParserOutput[]): StructuredResult {
  const byKey = new Map<string, { winner: ExtractedFact; alts: ExtractedFact[] }>();
  for (const out of outputs) {
    for (const fact of out.facts) {
      const slot = byKey.get(fact.rawKey);
      if (!slot) {
        byKey.set(fact.rawKey, { winner: fact, alts: [] });
      } else if (fact.confidence > slot.winner.confidence) {
        slot.alts.push(slot.winner);
        slot.winner = fact;
      } else {
        slot.alts.push(fact);
      }
    }
  }

  const facts: ExtractedFact[] = [];
  for (const { winner, alts } of byKey.values()) {
    // Preserve full {value, sourcePointer, confidence} for each loser so the
    // cross-source-conflict detector can compare real values across sources.
    // Drop alts whose value matches the winner — those aren't conflicts.
    const sourceAlternatives = alts
      .filter((f) => !sameValue(f.extractedValue, winner.extractedValue))
      .map((f) => ({
        value: f.extractedValue,
        sourcePointer: f.sourcePointer,
        confidence: f.confidence,
      }));
    facts.push({
      ...winner,
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
