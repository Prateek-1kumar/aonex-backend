// Postgres enums shared across schema files.

import { pgEnum } from "drizzle-orm/pg-core";

/** HLD §11 / LLD §12 — Phase 1 = shopify only, others stub. */
export const marketplaceEnum = pgEnum("marketplace", [
  "shopify",
  "amazon",
  "ebay",
  "walmart",
  "etsy"
]);

/**
 * HLD §20 — connection lifecycle.
 * `pending_failed` is from LLD §6.1 (auth attempt failed before token issued).
 */
export const connectionStatusEnum = pgEnum("connection_status", [
  "pending",
  "pending_failed",
  "active",
  "refresh_failing",
  "revoked",
  "deleted"
]);

/** HLD §20 — source_artifacts.status */
export const artifactStatusEnum = pgEnum("artifact_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "needs_review"
]);

/** HLD §20 — ingestion_jobs.status (BullMQ mirror) */
export const ingestionJobStatusEnum = pgEnum("ingestion_job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "rate_limited"
]);

/** HLD §22.4 RBAC roles */
export const merchantRoleEnum = pgEnum("merchant_role", [
  "admin",
  "operator",
  "reviewer",
  "analyst",
  "auditor"
]);

/** Audit actor categories — HLD §6 / §20 */
export const actorTypeEnum = pgEnum("actor_type", ["user", "system", "policy", "worker", "nango"]);

/** GDPR deletion request flow — LLD §15 */
export const deletionRequestStatusEnum = pgEnum("deletion_request_status", [
  "pending",
  "in_progress",
  "completed",
  "rejected"
]);

/** Tenant-level lifecycle — HLD §20 */
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended", "archived"]);

// ---------- Phase 2 enums ------------------------------------------------

/** HLD §14 / §20 — proposed_diffs.status routing outcomes */
export const proposedDiffStatusEnum = pgEnum("proposed_diff_status", [
  "pending",
  "open",
  "auto_approved",
  "approved",
  "rejected"
]);

/** HLD §9 — how a fact value was obtained */
export const extractionMethodEnum = pgEnum("extraction_method", [
  "direct",
  "computed",
  "inferred"
]);

/** HLD §15 / §20 — review_tasks.severity */
export const reviewTaskSeverityEnum = pgEnum("review_task_severity", [
  "low",
  "medium",
  "high",
  "critical"
]);

/** HLD §15 / §20 — review_tasks.status */
export const reviewTaskStatusEnum = pgEnum("review_task_status", [
  "open",
  "in_progress",
  "resolved",
  "dismissed"
]);

/** HLD §13 / §20 — deduplication decision kind */
export const dedupKindEnum = pgEnum("dedup_kind", [
  "new",
  "merge",
  "review",
  "conflict"
]);

/** HLD §8 / §20 — product lifecycle */
export const productStatusEnum = pgEnum("product_status", [
  "active",
  "draft",
  "archived",
  "deleted"
]);

/** HLD §20 — extraction_runs.status */
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
