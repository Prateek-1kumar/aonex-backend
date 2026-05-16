import { applyApprovedDiff } from "@aonex/catalog-service";
import type { DrizzleClient } from "@aonex/db";

export interface RunApproveInput {
  db: DrizzleClient;
  diffId: string;
}

export async function runApprove(input: RunApproveInput): Promise<{
  productId: string;
  productVersionId: string;
}> {
  const result = await applyApprovedDiff({
    db: input.db,
    diffId: input.diffId,
    approvalStatus: "auto_approved"
  });
  return { productId: result.productId, productVersionId: result.productVersionId };
}
