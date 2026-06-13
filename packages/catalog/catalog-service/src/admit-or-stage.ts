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
import type { Queue } from "bullmq";
import { classifyArchetype, type ClassifySignals } from "@aonex/archetypes";
import { resolveIdentityV2, identifierSetFromHint } from "./identity-resolver-v2.js";
import { decideResolution } from "./identity/resolve-v2.js";
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

// ---- Implementation ---------------------------------------------------------

export async function admitOrStage(
  input: AdmitOrStageInput
): Promise<AdmitOrStageResult> {
  const { db, tenantId, merchantId, adapterOutput: out } = input;

  // ---- 1. Resolve identity (legacy + Phase 2 V2 wrapper) -------------------
  // V2 returns the legacy result PLUS hydrated candidate rows (identifiers[]
  // + variantAxes) so decideResolution can apply the strong-key-or-Lab rule.
  // The legacy result still drives the enrichment path below for back-compat
  // with products that pre-date Phase 2's identifiers[] column.
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

  // ---- 2a. Phase 2 strong-key auto-merge ----------------------------------
  // decideResolution.auto_merge means: at least one candidate shares a STRONG
  // key with the incoming hint AND no variant conflict. Attach to that row via
  // writeAdapterOutput.forceProductId — which skips re-resolution so the
  // legacy GTIN/MPN paths don't need to also find the match. This catches
  // Phase 2 products whose strong keys live in identifiers[] without a legacy
  // identity.gtin mirror (the row would be invisible to the legacy resolver).
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

  // ---- 2b. Legacy enrichment path: existing LIVE product found ------------
  // When the LEGACY resolver found a confident match and there's a live
  // candidate, this is new data for an already-known product. Always write —
  // never stage. Retained for products that pre-date Phase 2's identifiers[]
  // column (where decideResolution would fall back to propose_lab on the bare
  // fuzzy/strength score because the candidate's identifiers[] is empty).
  //
  // Phase 2 Task 13 (D5 heal-on-touch): when decideResolution returns
  // propose_lab — i.e. a Lab proposal is warranted (variant conflict, or fuzzy
  // match to an OLD weak-identity row) — do NOT silently enrich. The propose_lab
  // decision is the Lab proposal; deferring to it is what makes "heal-on-touch
  // proposes to the Lab unless the key is strong+corroborated" hold. Without
  // this guard a strong-keyed incoming would silently land on an old weak row
  // without backfilling its identifiers — the exact duplication-resurfacing the
  // heal mechanism exists to prevent.
  const liveMatch = legacyRes.candidates.find((c) => c.kind === "live");

  if (
    decision.action !== "propose_lab" &&
    legacyRes.productId !== null &&
    liveMatch !== undefined
  ) {
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
        : {}),
      ...(input.reconcilerQueue !== undefined ? { reconcilerQueue: input.reconcilerQueue } : {})
    });
    return { outcome: "enriched", productId: w.productId, stagedProductId: null };
  }

  // ---- 3. New product path: evaluate gate ---------------------------------
  const signals: GateSignal[] = [];
  // identity-resolver sets matchPath="fuzzy_review" and reviewTaskSuggested
  // together (one return path), so today either check alone suffices; we guard
  // both for forward-compat if the resolver gains another review trigger.
  if (legacyRes.matchPath === "fuzzy_review" || legacyRes.reviewTaskSuggested) {
    signals.push({
      signalKind: "identity_conflict",
      severity: "high",
      blocking: true
    });
  }
  // Phase 2: decideResolution.propose_lab means strong-key-with-variant-conflict
  // OR a fuzzy candidate — both need human confirmation before merging. Forces
  // stage via a blocking signal; the legacy identity_conflict push above stays
  // additive (Phase 2 Task N+ will clean up the overlap).
  if (decision.action === "propose_lab") {
    signals.push({
      signalKind: "merge_candidate",
      severity: "high",
      blocking: true
    });

    // Phase 2 Task 13 (D5): heal-on-touch. When the contested candidate is an
    // OLD (pipeline_version=1) row with an EMPTY identifiers[], the merge
    // proposal doubles as a heal request. The Lab's resolve flow will (in a
    // later phase) backfill the old row's identifiers[] from the incoming
    // strong key as part of the merge. .find(...) returns at most one match,
    // so we push at most ONE heal signal per ingest — honouring the plan's
    // "one heal attempt per ingest" bound and the "no transitive/cascading
    // auto-merge" rule (we only propose; we never autonomously merge).
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
      ...(input.categoryNodeId ? { categoryNodeId: input.categoryNodeId } : {}),
      ...(input.channelCodeToId !== undefined
        ? { channelCodeToId: input.channelCodeToId }
        : {}),
      ...(input.reconcilerQueue !== undefined ? { reconcilerQueue: input.reconcilerQueue } : {})
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
    ...(input.categoryNodeId ? { categoryNodeId: input.categoryNodeId } : {}),
    ...(input.sourceArtifactId !== undefined
      ? { sourceArtifactId: input.sourceArtifactId }
      : {}),
    verdict,
    matchCandidates: legacyRes.candidates
  });

  return { outcome: "staged", productId: null, stagedProductId: staged.stagedProductId };
}
