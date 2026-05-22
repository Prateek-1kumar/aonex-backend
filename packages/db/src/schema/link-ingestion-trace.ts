// Phase 9 reframing (catalog redesign Task 9.2) — link_ingestion_trace_runs,
// link_ingestion_trace_sets, link_ingestion_trace_facts.
//
// These tables are transient evidence of LLM extraction during link ingestion,
// NOT canonical catalog state. The catalog_products side tables (winning_values,
// catalog_pricing_current, etc.) are the source of truth.
//
// 14-day retention is enforced by the daily link-trace-cleanup job
// (apps/worker/src/jobs/link-trace-cleanup.ts).
//
// Idempotency key: UNIQUE on (artifact_id, extractor_version, mapper_version, policy_version_id).

import {
  pgTable,
  uuid,
  varchar,
  numeric,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { merchants } from "./merchants.js";
import { sourceArtifacts } from "./ingestion.js";
import { policyVersions } from "./policy.js";
import { extractionMethodEnum, extractionRunStatusEnum } from "./enums.js";

/**
 * HLD §9 / §20 — one row per extraction attempt per artifact.
 * UNIQUE on (artifact_id, extractor_version, mapper_version, policy_version_id)
 * makes re-runs idempotent — the duplicate insert is skipped.
 *
 * DB table: link_ingestion_trace_runs (renamed from extraction_runs in migration 0021).
 * Index names (idx_extraction_runs_*, uq_extraction_runs_*) preserved from before
 * the rename — cosmetic rename deferred (would require ACCESS EXCLUSIVE lock).
 */
export const linkIngestionTraceRuns = pgTable(
  "link_ingestion_trace_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => sourceArtifacts.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    extractorVersion: varchar("extractor_version", { length: 100 }).notNull(),
    mapperVersion: varchar("mapper_version", { length: 100 }).notNull(),
    policyVersionId: uuid("policy_version_id")
      .notNull()
      .references(() => policyVersions.id, { onDelete: "restrict" }),
    status: extractionRunStatusEnum("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorPayload: jsonb("error_payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    // Idempotency key per HLD §4 / spec §4 rule 10
    idempotency: uniqueIndex("uq_extraction_runs_idempotency").on(
      t.artifactId,
      t.extractorVersion,
      t.mapperVersion,
      t.policyVersionId
    ),
    artifactIdx: index("idx_extraction_runs_artifact").on(t.artifactId)
  })
);

/**
 * HLD §9 / §20 — the set of extracted facts produced by one extraction run.
 *
 * DB table: link_ingestion_trace_sets (renamed from extracted_fact_sets in migration 0021).
 */
export const linkIngestionTraceSets = pgTable(
  "link_ingestion_trace_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extractionRunId: uuid("extraction_run_id")
      .notNull()
      .references(() => linkIngestionTraceRuns.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    merchantId: uuid("merchant_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    runIdx: index("idx_extracted_fact_sets_run").on(t.extractionRunId)
  })
);

/**
 * HLD §9 / §20 — one row per extracted attribute fact.
 * raw_key: the source field name (e.g. "vendor").
 * canonical_path: null until the Semantic Mapper assigns it.
 * source_pointer: JSONPath into rawData (e.g. "$.variants[0].barcode").
 *
 * DB table: link_ingestion_trace_facts (renamed from extracted_facts in migration 0021).
 */
export const linkIngestionTraceFacts = pgTable(
  "link_ingestion_trace_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    factSetId: uuid("fact_set_id")
      .notNull()
      .references(() => linkIngestionTraceSets.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull(),
    rawKey: varchar("raw_key", { length: 200 }).notNull(),
    /** Assigned by the Semantic Mapper — null = unmapped */
    canonicalPath: varchar("canonical_path", { length: 200 }),
    extractedValue: jsonb("extracted_value").notNull(),
    normalizedValue: jsonb("normalized_value"),
    unit: varchar("unit", { length: 50 }),
    /** JSONPath into source_artifacts.raw_data — provenance pointer */
    sourcePointer: varchar("source_pointer", { length: 500 }).notNull(),
    extractionMethod: extractionMethodEnum("extraction_method").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    mappingMethod: varchar("mapping_method", { length: 50 }),
    /** Top-3 canonical-path candidates from semantic-mapper — HLD §10 */
    mappingCandidates: jsonb("mapping_candidates")
      .$type<Array<{ key: string; score: number }>>(),
    /**
     * Per-fact alternative sources (losers from structured-merge) preserved
     * through the pipeline so cross-source-conflict can compare real values,
     * not pointer strings. See Bug #1 fix.
     */
    sourceAlternatives: jsonb("source_alternatives")
      .$type<Array<{ value: unknown; sourcePointer: string; confidence: number }>>(),
    approved: boolean("approved").notNull().default(false)
  },
  (t) => ({
    factSetIdx: index("idx_extracted_facts_fact_set").on(t.factSetId),
    canonicalIdx: index("idx_extracted_facts_canonical").on(t.canonicalPath)
  })
);

export type LinkIngestionTraceRun = typeof linkIngestionTraceRuns.$inferSelect;
export type NewLinkIngestionTraceRun = typeof linkIngestionTraceRuns.$inferInsert;
export type LinkIngestionTraceSet = typeof linkIngestionTraceSets.$inferSelect;
export type NewLinkIngestionTraceSet = typeof linkIngestionTraceSets.$inferInsert;
export type LinkIngestionTraceFactRow = typeof linkIngestionTraceFacts.$inferSelect;
export type NewLinkIngestionTraceFact = typeof linkIngestionTraceFacts.$inferInsert;

// ---------------------------------------------------------------------------
// Back-compat aliases — deprecated, remove in a future cleanup pass.
// ---------------------------------------------------------------------------
/** @deprecated Use linkIngestionTraceRuns */
export const extractionRuns = linkIngestionTraceRuns;
/** @deprecated Use linkIngestionTraceSets */
export const extractedFactSets = linkIngestionTraceSets;
/** @deprecated Use linkIngestionTraceFacts */
export const extractedFacts = linkIngestionTraceFacts;
/** @deprecated Use LinkIngestionTraceRun */
export type ExtractionRun = LinkIngestionTraceRun;
/** @deprecated Use NewLinkIngestionTraceRun */
export type NewExtractionRun = NewLinkIngestionTraceRun;
/** @deprecated Use LinkIngestionTraceSet */
export type ExtractedFactSet = LinkIngestionTraceSet;
/** @deprecated Use NewLinkIngestionTraceSet */
export type NewExtractedFactSet = NewLinkIngestionTraceSet;
/** @deprecated Use LinkIngestionTraceFactRow */
export type ExtractedFactRow = LinkIngestionTraceFactRow;
/** @deprecated Use NewLinkIngestionTraceFact */
export type NewExtractedFact = NewLinkIngestionTraceFact;
