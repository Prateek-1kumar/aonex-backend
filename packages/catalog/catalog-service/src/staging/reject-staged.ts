// Anomaly Lab — staging gate. Reject a staged product. Terminal; kept for
// audit; never promoted. Spec §7.3.
import { eq, and } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";

export interface RejectStagedInput {
  db: DrizzleClient; tenantId: TenantId; stagedProductId: string; resolvedBy: string;
}

export async function rejectStagedProduct(input: RejectStagedInput): Promise<void> {
  const now = new Date();
  const res = await input.db.update(schema.stagedProducts)
    .set({ status: "rejected", resolvedBy: input.resolvedBy, resolvedAt: now, updatedAt: now })
    .where(and(
      eq(schema.stagedProducts.stagedProductId, input.stagedProductId),
      eq(schema.stagedProducts.tenantId, input.tenantId),
      eq(schema.stagedProducts.status, "pending")
    ))
    .returning({ id: schema.stagedProducts.stagedProductId });
  if (res.length === 0) throw new Error(`staged product ${input.stagedProductId} not pending`);
}
