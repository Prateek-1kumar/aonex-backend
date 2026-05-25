// Anomaly Lab — staging gate. Confirm a match candidate and promote the
// staged item onto that existing product (enrichment). Spec §7.2 / action ③.
import { eq, and } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";
import { promoteStagedProduct, type PromoteStagedResult } from "./promote-staged.js";

export interface LinkStagedInput {
  db: DrizzleClient; tenantId: TenantId; stagedProductId: string;
  confirmedProductId: string; resolvedBy: string; fills: Record<string, unknown>;
}

export async function linkStagedProduct(input: LinkStagedInput): Promise<PromoteStagedResult> {
  const [staged] = await input.db.select().from(schema.stagedProducts)
    .where(and(eq(schema.stagedProducts.stagedProductId, input.stagedProductId), eq(schema.stagedProducts.tenantId, input.tenantId)));
  if (!staged) throw new Error(`staged product ${input.stagedProductId} not found`);
  const candidates = (staged.matchCandidates as Array<{ productId: string }>) ?? [];
  if (!candidates.some((c) => c.productId === input.confirmedProductId)) {
    throw new Error(`product ${input.confirmedProductId} is not a candidate for staged ${input.stagedProductId}`);
  }
  return promoteStagedProduct({
    db: input.db, tenantId: input.tenantId, stagedProductId: input.stagedProductId,
    resolvedBy: input.resolvedBy, fills: input.fills, confirmedMatchProductId: input.confirmedProductId
  });
}
