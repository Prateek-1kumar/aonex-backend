import { eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { domainOf } from "@aonex/lib-utils";
import type { TenantId, MerchantId } from "@aonex/types";

/**
 * Payload for the "edit and approve" reviewer action.
 *
 * The reviewer may either:
 *  - rebind a mapping (newCanonicalPath is non-null) → writes a mapping_override row
 *  - update a value without rebinding (newCanonicalPath is null) → no override created
 *  - pick one of several conflicting candidates (pickedCandidateSource set) → semantic only
 */
export interface EditApprovePayload {
  fieldName: string;
  newCanonicalPath: string | null;
  newNormalizedValue: unknown;
  pickedCandidateSource?: string;
  reason?: string;
}

export interface ResolutionContext {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  reviewerId: string;
}

export async function editAndApprove(
  ctx: ResolutionContext,
  taskId: string,
  edit: EditApprovePayload
): Promise<{ overrideId: string | null }> {
  // 1. Load the review task
  const task = await ctx.db.query.reviewTasks.findFirst({
    where: (t, { eq }) => eq(t.id, taskId),
  });
  if (!task) throw new Error(`review_task ${taskId} not found`);
  if (task.tenantId !== ctx.tenantId) throw new Error("forbidden");

  let overrideId: string | null = null;

  if (edit.newCanonicalPath) {
    // 2. Walk the chain to get the source URL for domain extraction:
    //    reviewTask.proposedDiffId → proposedDiffs.sourceFactSetId
    //    → extractedFactSets.artifactId → sourceArtifacts.sourceExternalId
    let sourceExternalId = "";

    const diff = await ctx.db.query.proposedDiffs.findFirst({
      where: (d, { eq }) => eq(d.id, task.proposedDiffId),
    });

    if (diff?.sourceFactSetId) {
      const factSet = await ctx.db.query.extractedFactSets.findFirst({
        where: (fs, { eq }) => eq(fs.id, diff.sourceFactSetId),
      });

      if (factSet?.artifactId) {
        const artifact = await ctx.db.query.sourceArtifacts.findFirst({
          where: (a, { eq }) => eq(a.id, factSet.artifactId),
        });
        sourceExternalId = artifact?.sourceExternalId ?? "";
      }
    }

    const domain = domainOf(sourceExternalId);

    // 3. Write mapping_override scoped to (tenant, domain)
    const [override] = await ctx.db
      .insert(schema.mappingOverrides)
      .values({
        tenantId: ctx.tenantId,
        merchantId: ctx.merchantId,
        sourceKey: edit.fieldName,
        canonicalKey: edit.newCanonicalPath,
        domainPattern: domain || null,
        normalizationRule: null,
        usageCount: 0,
        createdBy: ctx.reviewerId,
        sourceReviewTaskId: taskId,
      })
      .returning({ id: schema.mappingOverrides.id });

    overrideId = override?.id ?? null;

    // 4. Write attribute_synonym candidate (unapproved — admin approves separately)
    if (edit.newCanonicalPath !== edit.fieldName) {
      await ctx.db
        .insert(schema.attributeSynonyms)
        .values({
          canonicalKey: edit.newCanonicalPath,
          synonym: edit.fieldName,
          source: "human_review",
          approvedAt: null,
          approvedBy: null,
        })
        .onConflictDoNothing();
    }
  }

  // 5. Patch proposed_diff payload with new value and flip status to approved
  const diff = await ctx.db.query.proposedDiffs.findFirst({
    where: (d, { eq }) => eq(d.id, task.proposedDiffId),
  });
  if (diff) {
    const payload = (diff.diffPayload as Record<string, unknown>) ?? {};
    payload[edit.fieldName] = edit.newNormalizedValue;
    await ctx.db
      .update(schema.proposedDiffs)
      .set({ status: "approved", diffPayload: payload })
      .where(eq(schema.proposedDiffs.id, task.proposedDiffId));
  }

  // 6. Mark review task resolved
  await ctx.db
    .update(schema.reviewTasks)
    .set({
      status: "resolved",
      resolutionNotes: edit.reason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.reviewTasks.id, taskId));

  return { overrideId };
}

export async function rejectTask(
  _ctx: ResolutionContext,
  _taskId: string,
  _reason: "wrong_value" | "missing_field" | "wrong_category" | "no_product_found",
  _note?: string
): Promise<{ failureId: string }> {
  throw new Error("not implemented — Plan B Task 17");
}

export async function mergeWithExisting(
  _ctx: ResolutionContext,
  _taskId: string,
  _existingProductId: string
): Promise<{ aliasId: string }> {
  throw new Error("not implemented — Plan B Task 18");
}

export async function resolveCluster(
  _ctx: ResolutionContext,
  _clusterKey: string,
  _action: "approve_all" | "reject_all",
  _bulkEdit?: { fieldName: string; newValue: unknown }
): Promise<{ resolvedCount: number; overridesCreated: number }> {
  throw new Error("not implemented — Plan B Task 19");
}
