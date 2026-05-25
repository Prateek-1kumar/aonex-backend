// Anomaly Lab — staging gate. Confirm a match candidate and promote the
// staged item onto that existing product (enrichment). Spec §7.2 / action ③.
import { eq, and } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";
import { promoteStagedProduct, type PromoteStagedResult } from "./promote-staged.js";

export interface LinkStagedInput {
  db: DrizzleClient;
  tenantId: TenantId;
  stagedProductId: string;
  confirmedProductId: string;
  resolvedBy: string;
  fills: Record<string, unknown>;
}

export async function linkStagedProduct(input: LinkStagedInput): Promise<PromoteStagedResult> {
  const [staged] = await input.db
    .select()
    .from(schema.stagedProducts)
    .where(
      and(
        eq(schema.stagedProducts.stagedProductId, input.stagedProductId),
        eq(schema.stagedProducts.tenantId, input.tenantId)
      )
    );
  if (!staged) throw new Error(`staged product ${input.stagedProductId} not found`);
  // Only LIVE candidates are linkable: their productId is a real
  // catalog_products id that writeAdapterOutput can attach to via forceProductId.
  // A kind:"staged" candidate's productId is a staged_products id (the resolver
  // reuses the productId slot, disambiguated by kind) — linking onto it would
  // fail in writeAdapterOutput. Staged-to-staged merge is a separate (deferred) op.
  const candidates = (staged.matchCandidates as Array<{ productId: string; kind?: string }>) ?? [];
  if (!candidates.some((c) => c.productId === input.confirmedProductId && c.kind === "live")) {
    throw new Error(`product ${input.confirmedProductId} is not a live candidate for staged ${input.stagedProductId}`);
  }
  return promoteStagedProduct({
    db: input.db,
    tenantId: input.tenantId,
    stagedProductId: input.stagedProductId,
    resolvedBy: input.resolvedBy,
    fills: input.fills,
    confirmedMatchProductId: input.confirmedProductId
  });
}
