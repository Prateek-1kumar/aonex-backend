// Anomaly Lab — Task 5. admitOrStage: single chokepoint every ingest funnels
// through. Routes an AdapterOutput to one of three outcomes:
//
//   "enriched" — resolved to an existing LIVE catalog product (GTIN/MPN match);
//                writes observations unconditionally and returns.
//   "admitted" — new product, passes the CANONICAL_MINIMUM gate; written to
//                catalog_products.
//   "staged"   — new product, fails the gate or has an identity conflict signal;
//                held in staged_products for operator review.
//
// See spec §4, §8; plan Task 5.

import type { DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId, ChannelId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import { resolveIdentity } from "./identity-resolver.js";
import { writeAdapterOutput } from "./catalog-write.js";
import { evaluateGate, type GateSignal } from "./gate/evaluate-gate.js";
import { stageProduct } from "./staging/stage-product.js";

// ---- Public types -----------------------------------------------------------

export interface AdmitOrStageInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  adapterOutput: AdapterOutput;
  sourceKind: string;
  actor: string;
  channelCode: string | null;
  /** Required when the AdapterOutput carries pricing/inventory observations. */
  channelCodeToId?: Record<string, ChannelId>;
  sourceArtifactId?: string;
}

export interface AdmitOrStageResult {
  outcome: "admitted" | "enriched" | "staged";
  /** Set for "admitted" and "enriched"; null for "staged". */
  productId: string | null;
  /** Set for "staged"; null for "admitted" and "enriched". */
  stagedProductId: string | null;
}

// ---- Implementation ---------------------------------------------------------

export async function admitOrStage(
  input: AdmitOrStageInput
): Promise<AdmitOrStageResult> {
  const { db, tenantId, merchantId, adapterOutput: out } = input;

  // ---- 1. Resolve identity (including staged candidates) -------------------
  const resolution = await resolveIdentity({
    db,
    tenantId,
    identityHint: out.identityHint,
    ...(out.identityHint.titleForFuzzy !== undefined
      ? { observationTitle: out.identityHint.titleForFuzzy }
      : {}),
    includeStaged: true
  });

  // ---- 2. Enrichment path: existing LIVE product found --------------------
  // When resolveIdentity found a confident match and there's a live candidate,
  // this is new data for an already-known product. Always write — never stage.
  const liveMatch = resolution.candidates.find((c) => c.kind === "live");

  if (resolution.productId !== null && liveMatch !== undefined) {
    const w = await writeAdapterOutput({
      db,
      tenantId,
      merchantId,
      adapterOutput: out,
      actor: input.actor,
      ...(input.channelCodeToId !== undefined
        ? { channelCodeToId: input.channelCodeToId }
        : {})
    });
    return { outcome: "enriched", productId: w.productId, stagedProductId: null };
  }

  // ---- 3. New product path: evaluate gate ---------------------------------
  const signals: GateSignal[] = [];
  if (resolution.matchPath === "fuzzy_review" || resolution.reviewTaskSuggested) {
    signals.push({
      signalKind: "identity_conflict",
      severity: "high",
      blocking: true
    });
  }

  const verdict = evaluateGate({ adapterOutput: out, signals });

  // ---- 4. Admit -----------------------------------------------------------
  if (verdict.admit) {
    const w = await writeAdapterOutput({
      db,
      tenantId,
      merchantId,
      adapterOutput: out,
      actor: input.actor,
      ...(input.channelCodeToId !== undefined
        ? { channelCodeToId: input.channelCodeToId }
        : {})
    });
    return { outcome: "admitted", productId: w.productId, stagedProductId: null };
  }

  // ---- 5. Stage -----------------------------------------------------------
  const staged = await stageProduct({
    db,
    tenantId,
    merchantId,
    adapterOutput: out,
    sourceKind: input.sourceKind,
    channelCode: input.channelCode,
    ...(input.sourceArtifactId !== undefined
      ? { sourceArtifactId: input.sourceArtifactId }
      : {}),
    verdict,
    matchCandidates: resolution.candidates
  });

  return { outcome: "staged", productId: null, stagedProductId: staged.stagedProductId };
}
