// admitOrStage: the single chokepoint every ingest funnels through, routing an
// AdapterOutput to "enriched" (matched an existing LIVE product), "admitted"
// (new product passing the gate), or "staged" (held for operator review).
// propose_lab always defers to the Lab; the resolve here is routing-only —
// writeAdapterOutput re-resolves authoritatively in its txn (deliberate double-read).

import type { DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId, ChannelId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import type { Queue } from "bullmq";
import { classifyArchetype, type ClassifySignals } from "@aonex/archetypes";
import { resolveIdentityV2, identifierSetFromHint } from "./identity-resolver-v2.js";
import { decideResolution } from "./identity/resolve-v2.js";
import { writeAdapterOutput } from "./catalog-write.js";
import { evaluateGate, type GateSignal } from "./gate/evaluate-gate.js";
import { latestObservationValue } from "./observation-helpers.js";
import { stageProduct } from "./staging/stage-product.js";

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
  /** Canonical taxonomy node resolved at ingestion; stamped on admit (new
   *  product) and stage. Omitted → category left null for the sweep backstop. */
  categoryNodeId?: string | null;
  sourceArtifactId?: string;
  /** Per-tenant reconcile queue, forwarded to writeAdapterOutput for post-commit
   *  pricing/inventory reconcile. Optional → omit to skip enqueue. */
  reconcilerQueue?: Queue;
}

export interface AdmitOrStageResult {
  outcome: "admitted" | "enriched" | "staged";
  /** Set for "admitted" and "enriched"; null for "staged". */
  productId: string | null;
  /** Set for "staged"; null for "admitted" and "enriched". */
  stagedProductId: string | null;
}

export async function admitOrStage(
  input: AdmitOrStageInput
): Promise<AdmitOrStageResult> {
  const { db, tenantId, merchantId, adapterOutput: out } = input;

  const resolution = await resolveIdentityV2({
    db,
    tenantId,
    merchantId,
    adapterOutput: out
  });
  const legacyRes = resolution.legacy;

  const incomingIds = identifierSetFromHint(out.identityHint);
  const incomingVariant: Record<string, string> = out.identityHint.variantAxes ?? {};
  const decision = decideResolution({
    incomingIds,
    incomingVariant,
    candidates: resolution.candidateRows
  });

  if (decision.action === "auto_merge" && decision.productId !== undefined) {
    const w = await writeAdapterOutput({
      db,
      tenantId,
      merchantId,
      adapterOutput: out,
      actor: input.actor,
      forceProductId: decision.productId,
      ...(input.channelCodeToId !== undefined
        ? { channelCodeToId: input.channelCodeToId }
        : {}),
      ...(input.reconcilerQueue !== undefined ? { reconcilerQueue: input.reconcilerQueue } : {})
    });
    return { outcome: "admitted", productId: w.productId, stagedProductId: null };
  }

  const liveMatch = legacyRes.candidates.find((c) => c.kind === "live");

  if (
    decision.action !== "propose_lab" &&
    legacyRes.productId !== null &&
    liveMatch !== undefined
  ) {
    const w = await writeAdapterOutput({
      db,
      tenantId,
      merchantId,
      adapterOutput: out,
      actor: input.actor,
      ...(input.channelCodeToId !== undefined
        ? { channelCodeToId: input.channelCodeToId }
        : {}),
      ...(input.reconcilerQueue !== undefined ? { reconcilerQueue: input.reconcilerQueue } : {})
    });
    return { outcome: "enriched", productId: w.productId, stagedProductId: null };
  }

  const signals: GateSignal[] = [];
  if (legacyRes.matchPath === "fuzzy_review" || legacyRes.reviewTaskSuggested) {
    signals.push({
      signalKind: "identity_conflict",
      severity: "high",
      blocking: true
    });
  }
  if (decision.action === "propose_lab") {
    signals.push({
      signalKind: "merge_candidate",
      severity: "high",
      blocking: true
    });

    const healCandidate = resolution.candidateMeta.find(
      (m) => m.pipelineVersion < 2 && m.identifiersEmpty
    );
    if (healCandidate) {
      signals.push({
        signalKind: "heal_on_touch",
        severity: "high",
        blocking: true
      });
    }
  }

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
    identifierExists: true
  });

  if (verdict.admit) {
    const w = await writeAdapterOutput({
      db,
      tenantId,
      merchantId,
      adapterOutput: out,
      actor: input.actor,
      ...(input.categoryNodeId ? { categoryNodeId: input.categoryNodeId } : {}),
      ...(input.channelCodeToId !== undefined
        ? { channelCodeToId: input.channelCodeToId }
        : {}),
      ...(input.reconcilerQueue !== undefined ? { reconcilerQueue: input.reconcilerQueue } : {})
    });
    return { outcome: "admitted", productId: w.productId, stagedProductId: null };
  }

  const staged = await stageProduct({
    db,
    tenantId,
    merchantId,
    adapterOutput: out,
    sourceKind: input.sourceKind,
    channelCode: input.channelCode,
    ...(input.categoryNodeId ? { categoryNodeId: input.categoryNodeId } : {}),
    ...(input.sourceArtifactId !== undefined
      ? { sourceArtifactId: input.sourceArtifactId }
      : {}),
    verdict,
    matchCandidates: legacyRes.candidates
  });

  return { outcome: "staged", productId: null, stagedProductId: staged.stagedProductId };
}
