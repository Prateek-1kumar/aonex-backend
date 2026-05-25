// Anomaly Lab — staging gate. Insert a gate-failed AdapterOutput into
// staged_products. Denormalises title/brand/price for the lab queue.

import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import type { GateVerdict } from "../gate/evaluate-gate.js";

export interface StageProductInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  adapterOutput: AdapterOutput;
  sourceKind: string;
  channelCode: string | null;
  sourceArtifactId?: string;
  verdict: GateVerdict;
  matchCandidates: Array<{ productId: string; score: number; kind: "live" | "staged" }>;
}

export interface StageProductResult { stagedProductId: string; }

function latest(out: AdapterOutput, code: string): unknown {
  let best: { observedAt: Date; value: unknown } | undefined;
  for (const o of out.observations) {
    if (o.attributeCode === code && (!best || o.observedAt > best.observedAt)) best = o;
  }
  return best?.value;
}

export async function stageProduct(input: StageProductInput): Promise<StageProductResult> {
  const { db, adapterOutput: out } = input;
  const title = latest(out, "title");
  const priceObs = out.pricingObservations[0];
  const amount = priceObs?.tiers.find((t) => typeof t.amount === "number")?.amount;

  const [row] = await db.insert(schema.stagedProducts).values({
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    proposedIdentity: out.identityHint,
    observations: out as unknown as object,
    denormTitle: typeof title === "string" ? title : null,
    denormBrand: out.identityHint.brand ?? null,
    denormPrice: typeof amount === "number" ? String(amount) : null,
    denormCurrency: priceObs?.currency ?? null,
    sourceKind: input.sourceKind,
    sourceArtifactId: input.sourceArtifactId ?? null,
    channelCode: input.channelCode,
    gateVerdict: {
      missingFields: input.verdict.missingFields,
      signals: [...input.verdict.blockingSignals, ...input.verdict.infoSignals]
    },
    matchCandidates: input.matchCandidates,
    status: "pending"
  } as never).returning({ id: schema.stagedProducts.stagedProductId });

  return { stagedProductId: row!.id };
}
