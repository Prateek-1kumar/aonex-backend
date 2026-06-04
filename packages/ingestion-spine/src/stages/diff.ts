// Spine stage: diff — upsert the proposed_diffs row for this fact set.
//
// runDiff inserts a `create` diff (status open or auto_approved) with
// onConflictDoNothing, returning { diffId, created }. `created` drives the
// orchestrator's idempotency: per-field rows and review_tasks write only on
// first insertion. Conflict-without-existing-row signals a broken idempotency key.

import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId } from "@aonex/types";

export interface RunDiffInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  factSetId: string;
  policyVersionId: string;
  confidenceScore: number;
  status: "open" | "auto_approved";
  payload: Record<string, unknown>;
}

export async function runDiff(input: RunDiffInput): Promise<{ diffId: string; created: boolean }> {
  const [row] = await input.db
    .insert(schema.proposedDiffs)
    .values({
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      sourceFactSetId: input.factSetId,
      diffType: "create",
      status: input.status,
      policyVersionId: input.policyVersionId,
      confidenceScore: String(input.confidenceScore),
      actorType: input.status === "auto_approved" ? "policy" : "system",
      diffPayload: input.payload
    })
    .onConflictDoNothing()
    .returning({ id: schema.proposedDiffs.id });

  if (row) return { diffId: row.id, created: true };

  const existing = await input.db.query.proposedDiffs.findFirst({
    where: (d, { and, eq }) => and(eq(d.sourceFactSetId, input.factSetId), eq(d.diffType, "create"))
  });
  if (!existing) {
    throw new Error(
      `Failed to persist proposed diff for factSetId=${input.factSetId}: insert conflicted but no existing row found (check uq_proposed_diffs_idempotency)`
    );
  }
  return { diffId: existing.id, created: false };
}
