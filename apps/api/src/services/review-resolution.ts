import { eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { domainOf } from "@aonex/lib-utils";
import { applyApprovedDiff } from "@aonex/catalog-service";
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

  // 5. Patch proposed_diff payload with the reviewer's edited value (before applying).
  //    Skip the write when the new value is "effectively empty" (undefined, null,
  //    or whitespace-only string). A reviewer clicking Edit & Approve without
  //    typing anything must NOT clobber the extracted value — otherwise we lose
  //    title/brand/etc. and applyApprovedDiff later throws on the missing field.
  const v = edit.newNormalizedValue;
  const isEffectivelyEmpty =
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "");

  if (!isEffectivelyEmpty) {
    const diff = await ctx.db.query.proposedDiffs.findFirst({
      where: (d, { eq }) => eq(d.id, task.proposedDiffId),
    });
    if (diff) {
      const payload = (diff.diffPayload as Record<string, unknown>) ?? {};
      payload[edit.fieldName] = edit.newNormalizedValue;
      await ctx.db
        .update(schema.proposedDiffs)
        .set({ diffPayload: payload })
        .where(eq(schema.proposedDiffs.id, task.proposedDiffId));
    }
  }

  // 6. Decide whether to materialize. Only call applyApprovedDiff when:
  //    (a) the diff is in an approvable state (still open/pending, not already
  //        rejected or materialized), AND
  //    (b) this is the LAST open task for the diff — otherwise the materialized
  //        version would miss edits from sibling tasks that haven't fired yet.
  //
  //    This prevents 500s when a sibling task rejected the diff first, and
  //    avoids the previous bug where the first task's call would materialize
  //    a partially-edited diff and subsequent edits would be silently lost.
  if (task.proposedDiffId) {
    const diffNow = await ctx.db.query.proposedDiffs.findFirst({
      where: (d, { eq }) => eq(d.id, task.proposedDiffId),
    });
    const otherOpen = await ctx.db.query.reviewTasks.findMany({
      where: (t, { and, eq, ne }) =>
        and(
          eq(t.proposedDiffId, task.proposedDiffId),
          eq(t.status, "open"),
          ne(t.id, taskId)
        ),
    });
    const isApprovable =
      diffNow && (diffNow.status === "open" || diffNow.status === "pending");
    if (isApprovable && otherOpen.length === 0) {
      await applyApprovedDiff({
        db: ctx.db,
        diffId: task.proposedDiffId,
        actorId: ctx.reviewerId,
        approvalStatus: "approved",
      });
    }
  }

  // 7. Mark review task resolved
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
  ctx: ResolutionContext,
  taskId: string,
  reason: "wrong_value" | "missing_field" | "wrong_category" | "no_product_found",
  note?: string
): Promise<{ failureId: string }> {
  const task = await ctx.db.query.reviewTasks.findFirst({
    where: (t, { eq }) => eq(t.id, taskId),
  });
  if (!task) throw new Error(`review_task ${taskId} not found`);
  if (task.tenantId !== ctx.tenantId) throw new Error("forbidden");

  // Walk the chain manually (no relations() in this codebase) to find the source URL.
  let sourceUrl = "";
  if (task.proposedDiffId) {
    const diff = await ctx.db.query.proposedDiffs.findFirst({
      where: (d, { eq }) => eq(d.id, task.proposedDiffId!),
    });
    if (diff?.sourceFactSetId) {
      const factSet = await ctx.db.query.extractedFactSets.findFirst({
        where: (f, { eq }) => eq(f.id, diff.sourceFactSetId),
      });
      if (factSet?.artifactId) {
        const artifact = await ctx.db.query.sourceArtifacts.findFirst({
          where: (a, { eq }) => eq(a.id, factSet.artifactId),
        });
        sourceUrl = (artifact?.sourceExternalId as string | undefined) ?? "";
      }
    }
  }

  const domain = domainOf(sourceUrl) || "unknown";

  // Upsert by (tenant, domain, reason) — increment occurrence_count if a row already exists.
  const existing = await ctx.db.query.extractionFailures.findFirst({
    where: (f, { and, eq }) =>
      and(eq(f.tenantId, ctx.tenantId), eq(f.domainPattern, domain), eq(f.reason, reason)),
  });

  let failureId: string;
  if (existing) {
    await ctx.db
      .update(schema.extractionFailures)
      .set({
        occurrenceCount: existing.occurrenceCount + 1,
        lastSeenAt: new Date(),
        reviewerNote: note ?? existing.reviewerNote,
      })
      .where(eq(schema.extractionFailures.id, existing.id));
    failureId = existing.id;
  } else {
    const evidence = (task.signalPayload as Record<string, unknown> | null)?.evidence;
    const sourcePointer = evidence ? JSON.stringify(evidence) : null;

    const [row] = await ctx.db
      .insert(schema.extractionFailures)
      .values({
        tenantId: ctx.tenantId,
        domainPattern: domain,
        rawKey: task.fieldName,
        sourcePointer,
        reason,
        reviewerNote: note ?? null,
        reviewTaskId: taskId,
      })
      .returning({ id: schema.extractionFailures.id });
    failureId = row!.id;
  }

  if (task.proposedDiffId) {
    await ctx.db
      .update(schema.proposedDiffs)
      .set({ status: "rejected" })
      .where(eq(schema.proposedDiffs.id, task.proposedDiffId));
  }

  await ctx.db
    .update(schema.reviewTasks)
    .set({ status: "resolved", resolutionNotes: note ?? null, updatedAt: new Date() })
    .where(eq(schema.reviewTasks.id, taskId));

  return { failureId };
}

export async function mergeWithExisting(
  ctx: ResolutionContext,
  taskId: string,
  existingProductId: string
): Promise<{ aliasId: string }> {
  const task = await ctx.db.query.reviewTasks.findFirst({
    where: (t, { eq }) => eq(t.id, taskId),
  });
  if (!task) throw new Error(`review_task ${taskId} not found`);
  if (task.tenantId !== ctx.tenantId) throw new Error("forbidden");

  // Walk the chain manually (Task 16 pattern)
  let sourceUrl = "";
  if (task.proposedDiffId) {
    const diff = await ctx.db.query.proposedDiffs.findFirst({
      where: (d, { eq }) => eq(d.id, task.proposedDiffId!),
    });
    if (diff?.sourceFactSetId) {
      const factSet = await ctx.db.query.extractedFactSets.findFirst({
        where: (f, { eq }) => eq(f.id, diff.sourceFactSetId),
      });
      if (factSet?.artifactId) {
        const artifact = await ctx.db.query.sourceArtifacts.findFirst({
          where: (a, { eq }) => eq(a.id, factSet.artifactId),
        });
        sourceUrl = (artifact?.sourceExternalId as string | undefined) ?? "";
      }
    }
  }

  if (!sourceUrl) throw new Error(`cannot derive sourceUrl for task ${taskId}`);

  const [alias] = await ctx.db
    .insert(schema.productIdentities)
    .values({
      productId: existingProductId,
      tenantId: ctx.tenantId,
      identityType: "url",
      identityValue: sourceUrl,
    })
    .onConflictDoNothing()
    .returning({ id: schema.productIdentities.id });

  // Merge → no new product_version, reject the proposed diff
  if (task.proposedDiffId) {
    await ctx.db
      .update(schema.proposedDiffs)
      .set({ status: "rejected" })
      .where(eq(schema.proposedDiffs.id, task.proposedDiffId));
  }

  await ctx.db
    .update(schema.reviewTasks)
    .set({
      status: "resolved",
      resolutionNotes: `merged into ${existingProductId}`,
      updatedAt: new Date(),
    })
    .where(eq(schema.reviewTasks.id, taskId));

  return { aliasId: alias?.id ?? "" };
}

export async function resolveCluster(
  ctx: ResolutionContext,
  clusterKey: string,
  action: "approve_all" | "reject_all",
  bulkEdit?: { fieldName: string; newValue: unknown }
): Promise<{ resolvedCount: number; overridesCreated: number }> {
  const tasks = await ctx.db.query.reviewTasks.findMany({
    where: (t, { and, eq }) =>
      and(eq(t.tenantId, ctx.tenantId), eq(t.clusterKey, clusterKey), eq(t.status, "open")),
  });

  let overridesCreated = 0;
  let resolvedCount = 0;

  for (const task of tasks) {
    try {
      if (action === "approve_all" && bulkEdit) {
        const result = await editAndApprove(ctx, task.id, {
          fieldName: bulkEdit.fieldName,
          newCanonicalPath: null,
          newNormalizedValue: bulkEdit.newValue,
          reason: `cluster bulk approve ${clusterKey}`,
        });
        if (result.overrideId) overridesCreated++;
      } else if (action === "reject_all") {
        await rejectTask(ctx, task.id, "wrong_value", `cluster bulk reject ${clusterKey}`);
      }
      resolvedCount++;
    } catch (err) {
      console.error("cluster resolve task failed", task.id, err);
    }
  }

  return { resolvedCount, overridesCreated };
}
