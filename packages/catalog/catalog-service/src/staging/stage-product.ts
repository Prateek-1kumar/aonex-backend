// Anomaly Lab — staging gate. Insert a gate-failed AdapterOutput into
// staged_products. Denormalises title/brand/price for the lab queue.

import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import type { GateVerdict } from "../gate/evaluate-gate.js";
import { latestObservationValue } from "../observation-helpers.js";

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

export async function stageProduct(input: StageProductInput): Promise<StageProductResult> {
  const { db, adapterOutput: out } = input;
  const title = latestObservationValue(out, "title");
  const priceObs = out.pricingObservations[0];
  const amount = priceObs?.tiers.find((t) => typeof t.amount === "number")?.amount;

  const [row] = await db.insert(schema.stagedProducts).values({
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    proposedIdentity: out.identityHint as unknown, // jsonb: object shape not statically known to Drizzle
    // observedAt fields are Date objects; they serialize to ISO strings in jsonb
    // and will be read back as strings — consumers must not expect Date objects.
    observations: out as unknown,                   // jsonb: AdapterOutput not assignable to Drizzle's JsonValue
    denormTitle: typeof title === "string" ? title : null,
    denormBrand: out.identityHint.brand ?? null,
    denormPrice: typeof amount === "number" ? String(amount) : null,
    denormCurrency: priceObs?.currency ?? null,
    sourceKind: input.sourceKind,
    sourceArtifactId: input.sourceArtifactId ?? null,
    channelCode: input.channelCode,
    gateVerdict: {                                   // jsonb: object literal — shape is known but Drizzle requires cast
      missingFields: input.verdict.missingFields,
      signals: [...input.verdict.blockingSignals, ...input.verdict.infoSignals]
    } as unknown,
    matchCandidates: input.matchCandidates as unknown, // jsonb: array of objects not assignable to JsonValue
    status: "pending"
  }).returning({ id: schema.stagedProducts.stagedProductId });

  if (!row) throw new Error("stageProduct: insert into staged_products returned no row");
  return { stagedProductId: row.id };
}
