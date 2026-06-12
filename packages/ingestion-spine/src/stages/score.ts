// Spine stage: score — run the policy engine to get a routing decision.
//
// runScore assembles a RouterInput from the mapped facts, validated attributes,
// domain, category confidence, and required attributes, then calls the policy
// engine's route(). Returns a RoutingDecision (score + auto_approve/review +
// detectors tripped) the orchestrator uses to branch. db/tenantId reserved for
// future DB-backed detectors.

import { route, type RouterInput, type RoutingDecision } from "@aonex/ingestion-policy-engine";
import type { MappedFactSet } from "@aonex/ingestion-semantic-mapper";
import type { DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";

/**
 * Core product fields for the policy payload. The semantic mapper only assigns
 * canonicalPath to category ATTRIBUTES, so core fields (title/brand/price/…)
 * never appear in `attributes` — reading them from there yields null and makes
 * `missing_required_attribute` + the title gate fire on every product. The
 * orchestrator passes these from the canonical skuJson instead.
 */
export interface ScoreCoreFields {
  title?: string | null;
  brand?: string | null;
  gtin?: string | null;
  modelNumber?: string | null;
  basePrice?: number | null;
  currency?: string | null;
  /** Canonical category (skuJson.category_path); also feeds category.path. */
  canonicalCategory?: string | null;
}

export interface RunScoreInput {
  db: DrizzleClient;
  tenantId: TenantId;
  mappedFactSet: MappedFactSet;
  /** From the validate stage — what was validated. */
  attributes: Record<string, unknown>;
  /** Core product fields (from skuJson). Take precedence over `attributes`. */
  coreFields?: ScoreCoreFields;
  /** Detector confidence in the assigned category. Pulled from category-detector elsewhere; 0.0 if unknown. */
  categoryConfidence: number;
  /** Host-only domain (e.g. "decathlon.com") used by per-domain reliability detectors. */
  domain: string;
  /** Required attributes for this category — feeds the missing_required_attribute detector. */
  categoryRequiredAttributes: string[];
}

// db/tenantId reserved for future detectors that need DB lookups (price-cluster, identity-index)
export async function runScore(input: RunScoreInput): Promise<RoutingDecision> {
  const core = input.coreFields ?? {};
  const canonicalCategory = core.canonicalCategory ?? input.mappedFactSet.categoryPath;
  const routerInput: RouterInput = {
    facts: input.mappedFactSet.facts,
    payload: {
      title: core.title ?? (input.attributes.title as string | null) ?? null,
      brand: core.brand ?? (input.attributes.brand as string | null) ?? null,
      gtin: core.gtin ?? (input.attributes.gtin as string | null) ?? null,
      modelNumber: core.modelNumber ?? (input.attributes.modelNumber as string | null) ?? null,
      basePrice: core.basePrice ?? (input.attributes.basePrice as number | null) ?? null,
      currency: core.currency ?? (input.attributes.currency as string | null) ?? null,
      canonicalCategory,
      variants: []
    },
    domain: input.domain,
    category: {
      path: canonicalCategory,
      confidence: input.categoryConfidence
    },
    categoryRequiredAttributes: input.categoryRequiredAttributes,
    identityIndex: {},
    priceCluster: null,
    variantAxes: {}
  };
  return route(routerInput);
}
