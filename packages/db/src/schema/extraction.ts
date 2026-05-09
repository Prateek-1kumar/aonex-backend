// HLD §9 / §20 — extraction_runs, extracted_fact_sets, extracted_facts.
// "Persist source_artifacts and extracted_facts before touching catalog tables" (HLD §2.4).
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
 */
export const extractionRuns = pgTable(
  "extraction_runs",
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
 */
export const extractedFactSets = pgTable(
  "extracted_fact_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extractionRunId: uuid("extraction_run_id")
      .notNull()
      .references(() => extractionRuns.id, { onDelete: "cascade" }),
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
 */
export const extractedFacts = pgTable(
  "extracted_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    factSetId: uuid("fact_set_id")
      .notNull()
      .references(() => extractedFactSets.id, { onDelete: "cascade" }),
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
    /** Top-3 mapping candidates with scores — HLD §10 */
    mappingCandidates: jsonb("mapping_candidates")
      .$type<Array<{ key: string; score: number }>>(),
    approved: boolean("approved").notNull().default(false)
  },
  (t) => ({
    factSetIdx: index("idx_extracted_facts_fact_set").on(t.factSetId),
    canonicalIdx: index("idx_extracted_facts_canonical").on(t.canonicalPath)
  })
);

export type ExtractionRun = typeof extractionRuns.$inferSelect;
export type NewExtractionRun = typeof extractionRuns.$inferInsert;
export type ExtractedFactSet = typeof extractedFactSets.$inferSelect;
export type NewExtractedFactSet = typeof extractedFactSets.$inferInsert;
export type ExtractedFactRow = typeof extractedFacts.$inferSelect;
export type NewExtractedFact = typeof extractedFacts.$inferInsert;
