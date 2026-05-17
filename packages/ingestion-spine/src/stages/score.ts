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
  const routerInput: RouterInput = {
    facts: input.mappedFactSet.facts,
    payload: {
      title: (input.attributes.title as string | null) ?? null,
      brand: (input.attributes.brand as string | null) ?? null,
      gtin: (input.attributes.gtin as string | null) ?? null,
      modelNumber: (input.attributes.modelNumber as string | null) ?? null,
      basePrice: (input.attributes.basePrice as number | null) ?? null,
      currency: (input.attributes.currency as string | null) ?? null,
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
