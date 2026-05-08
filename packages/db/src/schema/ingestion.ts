// HLD §20 — source_artifacts + ingestion_jobs.
// `source_artifacts` is the immutable raw evidence ("Persist
// source_artifacts and extracted_facts before touching catalog tables")
// — Phase 1 implements this; Phase 2 adds extraction_runs/extracted_facts.

import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  text,
  integer,
  index,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { merchants } from "./merchants.js";
import { marketplaceEnum, artifactStatusEnum, ingestionJobStatusEnum } from "./enums.js";

export const sourceArtifacts = pgTable(
  "source_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    /** "marketplace_connector" | "templated_csv" — HLD §11 */
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceMarketplace: marketplaceEnum("source_marketplace"),
    /** Marketplace's external id (e.g. Shopify product gid). */
    sourceExternalId: varchar("source_external_id", { length: 200 }).notNull(),
    /** For CSV row-level artifacts that descend from a file-level artifact. */
    parentArtifactId: uuid("parent_artifact_id"),
    /** S3 / object-storage URI for raw CSV files (file-level artifacts). */
    storageUri: varchar("storage_uri", { length: 500 }),
    /** Raw record as Nango / CSV gave us — immutable. */
    rawData: jsonb("raw_data").$type<Record<string, unknown>>().notNull(),
    /** SHA-256 hex of canonicalStringify(rawData) — drives staging dedup. */
    checksum: varchar("checksum", { length: 64 }).notNull(),
    status: artifactStatusEnum("status").notNull().default("pending"),
    processingErrors: jsonb("processing_errors").$type<Record<string, unknown>[]>(),
    /** Set by drain processor — which sync run produced this row. */
    syncJobRunId: uuid("sync_job_run_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Marketplace-side modification timestamp (best-effort). */
    modifiedAt: timestamp("modified_at", { withTimezone: true })
  },
  (t) => ({
    // HLD-mandated idempotency at the persistence boundary.
    dedup: uniqueIndex("uq_source_artifacts_dedup").on(
      t.merchantId,
      t.sourceMarketplace,
      t.sourceExternalId,
      t.checksum
    ),
    merchantStatus: index("idx_source_artifacts_merchant_status").on(t.merchantId, t.status),
    modifiedIdx: index("idx_source_artifacts_modified").on(t.sourceMarketplace, t.modifiedAt)
  })
);

/**
 * Per-job record mirroring BullMQ — used by the audit + cost ledger.
 * HLD §20.
 */
export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id"),
    tenantId: uuid("tenant_id").notNull(),
    merchantId: uuid("merchant_id").notNull(),
    /** "auth" | "sync" | "drain" | "extract" | ... */
    jobType: varchar("job_type", { length: 32 }).notNull(),
    status: ingestionJobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    requestId: varchar("request_id", { length: 64 }),
    traceId: varchar("trace_id", { length: 64 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorPayload: jsonb("error_payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    merchantIdx: index("idx_ingestion_jobs_merchant").on(t.merchantId, t.createdAt),
    statusIdx: index("idx_ingestion_jobs_status").on(t.status)
  })
);

/**
 * Per-sync rollup — webhook-driven sync run summary.
 * Auxiliary table from LLD §6 (records_added/updated/failed).
 */
export const syncJobRuns = pgTable(
  "sync_job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    marketplace: marketplaceEnum("marketplace").notNull(),
    webhookId: varchar("webhook_id", { length: 200 }).notNull(),
    syncMode: varchar("sync_mode", { length: 20 }).notNull(), // 'INITIAL' | 'INCREMENTAL' | 'FULL'
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    recordsAdded: integer("records_added").notNull().default(0),
    recordsUpdated: integer("records_updated").notNull().default(0),
    recordsFailed: integer("records_failed").notNull().default(0),
    errorPayload: jsonb("error_payload").$type<Record<string, unknown>>()
  },
  (t) => ({
    webhookIdx: index("idx_sync_runs_webhook").on(t.webhookId)
  })
);

export type SourceArtifact = typeof sourceArtifacts.$inferSelect;
export type NewSourceArtifact = typeof sourceArtifacts.$inferInsert;
export type IngestionJob = typeof ingestionJobs.$inferSelect;
export type SyncJobRun = typeof syncJobRuns.$inferSelect;
