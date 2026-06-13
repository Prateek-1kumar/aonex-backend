// catalog_product_revisions: append-only revision log for catalog_products.
// INSERTs only — UPDATE/DELETE are blocked by trg_revisions_immutable; partitioning
// lives in raw SQL, so this Drizzle def is for typing only.

import { pgTable, uuid, bigint, jsonb, text, timestamp, boolean, index, primaryKey } from "drizzle-orm/pg-core";

export const catalogProductRevisions = pgTable(
  "catalog_product_revisions",
  {
    revisionId:            bigint("revision_id", { mode: "number" }).generatedByDefaultAsIdentity(),
    productId:             uuid("product_id").notNull(),
    tenantId:              uuid("tenant_id").notNull(),
    valuesSnapshot:        jsonb("values_snapshot").notNull(),
    winningSnapshot:       jsonb("winning_snapshot"),
    diff:                  jsonb("diff"),
    revisionReason:        text("revision_reason").notNull(),
    sourceKind:            text("source_kind"),
    sourceRecordId:        text("source_record_id"),
    triggeredByArtifactId: uuid("triggered_by_artifact_id"),
    rawPayload:            jsonb("raw_payload"),
    observedAt:            timestamp("observed_at", { withTimezone: true }),
    ingestedAt:            timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    actor:                 text("actor"),
    suppressOutbound:      boolean("suppress_outbound").notNull().default(false)
  },
  (t) => ({
    pk:         primaryKey({ columns: [t.revisionId, t.ingestedAt] }),
    productIdx: index("idx_revisions_product").on(t.productId, t.ingestedAt),
    sourceIdx:  index("idx_revisions_source").on(t.sourceKind, t.sourceRecordId)
  })
);

export type CatalogProductRevision = typeof catalogProductRevisions.$inferSelect;
export type NewCatalogProductRevision = typeof catalogProductRevisions.$inferInsert;
