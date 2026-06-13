// Postgres enums shared across schema files.

import { pgEnum } from "drizzle-orm/pg-core";

/** Supported marketplaces (currently shopify is live; others are stubs). */
export const marketplaceEnum = pgEnum("marketplace", [
  "shopify",
  "amazon",
  "ebay",
  "walmart",
  "etsy"
]);

/**
 * Connection lifecycle.
 * `pending_failed` = auth attempt failed before a token was issued.
 */
export const connectionStatusEnum = pgEnum("connection_status", [
  "pending",
  "pending_failed",
  "active",
  "refresh_failing",
  "revoked",
  "deleted"
]);

/** source_artifacts.status. */
export const artifactStatusEnum = pgEnum("artifact_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "needs_review"
]);

/** ingestion_jobs.status (BullMQ mirror). */
export const ingestionJobStatusEnum = pgEnum("ingestion_job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "rate_limited"
]);

/** RBAC roles. */
export const merchantRoleEnum = pgEnum("merchant_role", [
  "admin",
  "operator",
  "reviewer",
  "analyst",
  "auditor"
]);

/** Audit actor categories. */
export const actorTypeEnum = pgEnum("actor_type", ["user", "system", "policy", "worker", "nango"]);

/** GDPR deletion request flow. */
export const deletionRequestStatusEnum = pgEnum("deletion_request_status", [
  "pending",
  "in_progress",
  "completed",
  "rejected"
]);

/** Tenant-level lifecycle. */
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended", "archived"]);

/** proposed_diffs.status routing outcomes. */
export const proposedDiffStatusEnum = pgEnum("proposed_diff_status", [
  "pending",
  "open",
  "auto_approved",
  "approved",
  "rejected"
]);

/** How a fact value was obtained. */
export const extractionMethodEnum = pgEnum("extraction_method", [
  "direct",
  "computed",
  "inferred",
  "override"
]);

/** review_tasks.severity. */
export const reviewTaskSeverityEnum = pgEnum("review_task_severity", [
  "low",
  "medium",
  "high",
  "critical"
]);

/** review_tasks.status. */
export const reviewTaskStatusEnum = pgEnum("review_task_status", [
  "open",
  "in_progress",
  "resolved",
  "dismissed"
]);

/** Deduplication decision kind. */
export const dedupKindEnum = pgEnum("dedup_kind", [
  "new",
  "merge",
  "review",
  "conflict"
]);

/** Product lifecycle. */
export const productStatusEnum = pgEnum("product_status", [
  "active",
  "draft",
  "archived",
  "deleted"
]);

/** extraction_runs.status. */
export const extractionRunStatusEnum = pgEnum("extraction_run_status", [
  "pending",
  "running",
  "succeeded",
  "failed"
]);

export const extractionFailureReasonEnum = pgEnum("extraction_failure_reason", [
  "fetch_blocked",
  "captcha_wall",
  "no_product_found",
  "parse_failed",
  "llm_extraction_failed",
  "wrong_value",
  "missing_field",
  "wrong_category",
]);
