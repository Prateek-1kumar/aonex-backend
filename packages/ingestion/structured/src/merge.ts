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
    const alt = alts.map((f) => ({
      key: f.sourcePointer,
      score: f.confidence,
      reason: "alternative source",
    }));
    facts.push({
      ...winner,
      mappingCandidates: alt.length > 0 ? alt : null,
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
