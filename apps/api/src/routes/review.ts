import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type DrizzleClient } from "@aonex/db";
import { MerchantId, TenantId } from "@aonex/types";
import type { AuditEmitter } from "@aonex/audit";
import { applyApprovedDiff } from "@aonex/catalog-service";

const ReviewActionSchema = z.object({
  action: z.enum(["save", "approve", "reject", "dismiss"]),
  diff_payload: z.record(z.unknown()).optional(),
  resolution_notes: z.string().max(1000).optional(),
});

export interface ReviewRouteDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
}

export function reviewRoutes(deps: ReviewRouteDeps): Hono {
  const app = new Hono();

  app.get("/tasks", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
    const status = c.req.query("status") ?? "open";

    const tasks = await deps.db
      .select()
      .from(schema.reviewTasks)
      .where(
        and(
          eq(schema.reviewTasks.tenantId, tenantId),
          eq(schema.reviewTasks.merchantId, merchantId),
          eq(schema.reviewTasks.status, normalizeStatus(status))
        )
      )
      .orderBy(desc(schema.reviewTasks.createdAt));

    const hydrated = await Promise.all(
      tasks.map(async (task) => {
        const [diff, fields, artifact] = await Promise.all([
          deps.db.query.proposedDiffs.findFirst({
            where: (d, { eq }) => eq(d.id, task.proposedDiffId),
          }),
          deps.db
            .select()
            .from(schema.proposedDiffFields)
            .where(eq(schema.proposedDiffFields.diffId, task.proposedDiffId)),
          task.artifactId
            ? deps.db.query.sourceArtifacts.findFirst({
                where: (a, { eq }) => eq(a.id, task.artifactId as string),
              })
            : null,
        ]);

        return {
          ...task,
          proposed_diff: diff,
          fields,
          source_artifact: artifact
            ? {
                id: artifact.id,
                sourceType: artifact.sourceType,
                sourceExternalId: artifact.sourceExternalId,
                rawData: artifact.rawData,
                status: artifact.status,
              }
            : null,
        };
      })
    );

    return c.json({ data: { tasks: hydrated } });
  });

  app.get("/clusters", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const status = c.req.query("status") ?? "open";

    const rows = await deps.db
      .select({
        clusterKey: schema.reviewTasks.clusterKey,
        signalKind: schema.reviewTasks.signalKind,
        severity: schema.reviewTasks.severity,
        itemCount: sql<number>`count(*)::int`,
        lastUpdated: sql<Date>`max(${schema.reviewTasks.updatedAt})`,
      })
      .from(schema.reviewTasks)
      .where(
        and(
          eq(schema.reviewTasks.tenantId, tenantId),
          eq(schema.reviewTasks.status, normalizeStatus(status)),
          sql`${schema.reviewTasks.clusterKey} IS NOT NULL`
        )
      )
      .groupBy(
        schema.reviewTasks.clusterKey,
        schema.reviewTasks.signalKind,
        schema.reviewTasks.severity
      )
      .orderBy(desc(sql`max(${schema.reviewTasks.updatedAt})`));

    return c.json({ success: true, data: { clusters: rows } });
  });

  app.patch("/tasks/:id", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
    const requestId = c.get("requestId" as never) as string | undefined;
    const taskId = c.req.param("id");
    const parsed = ReviewActionSchema.safeParse(await c.req.json());

    if (!parsed.success) {
      return c.json({ error: { code: "VALIDATION_FAILED", message: "Invalid review action" } }, 400);
    }

    const task = await deps.db.query.reviewTasks.findFirst({
      where: (t, { and, eq }) =>
        and(eq(t.id, taskId), eq(t.tenantId, tenantId), eq(t.merchantId, merchantId)),
    });

    if (!task) {
      return c.json({ error: { code: "NOT_FOUND", message: "Review task not found" } }, 404);
    }

    if (parsed.data.diff_payload) {
      await deps.db
        .update(schema.proposedDiffs)
        .set({ diffPayload: parsed.data.diff_payload })
        .where(eq(schema.proposedDiffs.id, task.proposedDiffId));
    }

    if (parsed.data.action === "save") {
      await deps.db
        .update(schema.reviewTasks)
        .set({
          status: "in_progress",
          resolutionNotes: parsed.data.resolution_notes ?? task.resolutionNotes,
          updatedAt: new Date(),
        })
        .where(eq(schema.reviewTasks.id, task.id));

      return c.json({ data: { task_id: task.id, status: "in_progress" } });
    }

    if (parsed.data.action === "approve") {
      const applied = await applyApprovedDiff({
        db: deps.db,
        diffId: task.proposedDiffId,
        actorId: null,
        approvalStatus: "approved",
      });

      await deps.db
        .update(schema.reviewTasks)
        .set({
          status: "resolved",
          resolutionNotes: parsed.data.resolution_notes ?? "Approved",
          updatedAt: new Date(),
        })
        .where(eq(schema.reviewTasks.id, task.id));

      await deps.audit.emit({
        tenantId,
        merchantId,
        actorType: "user",
        eventType: "review_task.approved",
        entityType: "review_task",
        entityId: task.id,
        ...(requestId ? { requestId } : {}),
        metadata: { ...applied },
      });

      return c.json({ data: { task_id: task.id, status: "resolved", catalog: applied } });
    }

    if (parsed.data.action === "reject") {
      await deps.db
        .update(schema.proposedDiffs)
        .set({
          status: "rejected",
          rejectionReason: parsed.data.resolution_notes ?? "Rejected in Anomaly Lab",
          reviewedAt: new Date(),
        })
        .where(eq(schema.proposedDiffs.id, task.proposedDiffId));
    }

    await deps.db
      .update(schema.reviewTasks)
      .set({
        status: parsed.data.action === "dismiss" ? "dismissed" : "resolved",
        resolutionNotes: parsed.data.resolution_notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.reviewTasks.id, task.id));

    const eventType =
      parsed.data.action === "dismiss" ? "review_task.dismissed" : "review_task.rejected";

    await deps.audit.emit({
      tenantId,
      merchantId,
      actorType: "user",
      eventType,
      entityType: "review_task",
      entityId: task.id,
      ...(requestId ? { requestId } : {}),
      metadata: { proposedDiffId: task.proposedDiffId },
    });

    return c.json({
      data: {
        task_id: task.id,
        status: parsed.data.action === "dismiss" ? "dismissed" : "resolved",
      },
    });
  });

  return app;
}

function normalizeStatus(status: string): "open" | "in_progress" | "resolved" | "dismissed" {
  if (status === "in_progress" || status === "resolved" || status === "dismissed") {
    return status;
  }
  return "open";
}
