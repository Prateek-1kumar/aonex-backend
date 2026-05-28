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
import { classifyArchetype, type ClassifySignals } from "@aonex/archetypes";
import { resolveIdentity } from "./identity-resolver.js";
import { writeAdapterOutput } from "./catalog-write.js";
import { evaluateGate, type GateSignal } from "./gate/evaluate-gate.js";
import { latestObservationValue } from "./observation-helpers.js";
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
    // NB: writeAdapterOutput re-resolves identity authoritatively inside its
    // own transaction; the resolve above is routing-only and is not threaded
    // in. The second resolve is the source of truth (and is race-safe within
    // the txn) — so this is a deliberate double-read, not a correctness gap.
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
  // identity-resolver sets matchPath="fuzzy_review" and reviewTaskSuggested
  // together (one return path), so today either check alone suffices; we guard
  // both for forward-compat if the resolver gains another review trigger.
  if (resolution.matchPath === "fuzzy_review" || resolution.reviewTaskSuggested) {
    signals.push({
      signalKind: "identity_conflict",
      severity: "high",
      blocking: true
    });
  }

  // Phase 1: when the archetype flag is on for this product's archetype, the
  // gate delegates to weighted completeness scoring (see evaluate-gate.ts).
  // Classify here using the same Task 10 pattern that catalog-write uses, so
  // the routing decision and the eventual archetype family stamp stay aligned.
  const classifySignals: ClassifySignals = {};
  const titleVal = latestObservationValue(out, "title");
  if (typeof titleVal === "string") classifySignals.title = titleVal;
  const categoryVal = latestObservationValue(out, "category_path");
  if (typeof categoryVal === "string") classifySignals.categoryPath = categoryVal;
  if (typeof out.identityHint.brand === "string") classifySignals.brand = out.identityHint.brand;
  const archetypeId = classifyArchetype(classifySignals);

  const verdict = evaluateGate({
    adapterOutput: out,
    signals,
    archetypeId,
    allowlist: process.env.AONEX_ARCHETYPE_VERTICALS ?? "",
    threshold: 0.8,
    // Phase 2 will thread the real value; in Phase 1 we hardcode true so the
    // identifier hard-floor matches legacy behaviour for now.
    identifierExists: true
  });

  // ---- 4. Admit -----------------------------------------------------------
  if (verdict.admit) {
    // As above: writeAdapterOutput re-resolves identity authoritatively in its
    // own transaction (here it will find no match and create the product).
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
