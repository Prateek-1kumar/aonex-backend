import { route, type RouterInput, type RoutingDecision } from "@aonex/ingestion-policy-engine";
import type { MappedFactSet } from "@aonex/ingestion-semantic-mapper";
import type { DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";

export interface RunScoreInput {
  db: DrizzleClient;
  tenantId: TenantId;
  mappedFactSet: MappedFactSet;
  /** From the validate stage — what was validated. */
  attributes: Record<string, unknown>;
  /** Detector confidence in the assigned category. Pulled from category-detector elsewhere; 0.0 if unknown. */
  categoryConfidence: number;
  /** Host-only domain (e.g. "decathlon.com") used by per-domain reliability detectors. */
  domain: string;
  /** Required attributes for this category — feeds the missing_required_attribute detector. */
  categoryRequiredAttributes: string[];
}

// db/tenantId reserved for future detectors that need DB lookups (price-cluster, identity-index)
export async function runScore(input: RunScoreInput): Promise<RoutingDecision> {
  // The Phase 3 category schemas (and the semantic mapper) use snake_case
  // canonical paths (base_price, model_number) but the RouterInput payload
  // is camelCase. Read both forms so a snake_case attribute satisfies the
  // missing_required_attribute detector. Snake takes precedence (mapper
  // canonical) with camel as a fallback for hand-edited diffs.
  const pickStr = (snake: string, camel: string): string | null => {
    const v = input.attributes[snake] ?? input.attributes[camel];
    return typeof v === "string" ? v : v == null ? null : String(v);
  };
  const pickNum = (snake: string, camel: string): number | null => {
    const v = input.attributes[snake] ?? input.attributes[camel];
    if (v == null) return null;
    if (typeof v === "number") return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const routerInput: RouterInput = {
    facts: input.mappedFactSet.facts,
    payload: {
      title: pickStr("title", "title"),
      brand: pickStr("brand", "brand"),
      gtin: pickStr("gtin", "gtin"),
      modelNumber: pickStr("model_number", "modelNumber"),
      basePrice: pickNum("base_price", "basePrice"),
      currency: pickStr("currency", "currency"),
      canonicalCategory: input.mappedFactSet.categoryPath,
      variants: []
    },
    domain: input.domain,
    category: {
      path: input.mappedFactSet.categoryPath,
      confidence: input.categoryConfidence
    },
    categoryRequiredAttributes: input.categoryRequiredAttributes,
    identityIndex: {},
    priceCluster: null,
    variantAxes: {}
  };
  return route(routerInput);
}
