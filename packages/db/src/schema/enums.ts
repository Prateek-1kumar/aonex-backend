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
