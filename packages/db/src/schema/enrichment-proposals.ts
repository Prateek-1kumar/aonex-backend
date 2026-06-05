// Catalog enrichment Phase 1 — review-then-apply proposals.
// One row per "Push to Enrich" run; the catalog is untouched until apply.

import { pgTable, uuid, text, jsonb, numeric, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { catalogProducts } from "./catalog-products.js";

export const enrichmentProposals = pgTable(
  "enrichment_proposals",
  {
    proposalId:    uuid("proposal_id").primaryKey().defaultRandom(),
    tenantId:      uuid("tenant_id").notNull(),
    merchantId:    uuid("merchant_id").notNull(),
    productId:     uuid("product_id")
      .notNull()
      .references(() => catalogProducts.productId, { onDelete: "cascade" }),
    /** pending | generating | ready | applied | rejected | failed */
    status:        text("status").notNull().default("pending"),
    archetype:     text("archetype"),
    model:         text("model"),
    promptVersion: text("prompt_version").notNull().default("enrich-v1"),
    fields:        jsonb("fields").notNull().default(sql`'[]'::jsonb`),
    candidates:    jsonb("candidates").notNull().default(sql`'[]'::jsonb`),
    scoreBefore:   jsonb("score_before"),
    scoreAfter:    jsonb("score_after"),
    reasoning:     text("reasoning"),
    costUsd:       numeric("cost_usd", { precision: 10, scale: 5 }),
    jobId:         text("job_id"),
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedBy:    uuid("resolved_by"),
    resolvedAt:    timestamp("resolved_at", { withTimezone: true }),
    /** Stamped when the user sends the draft to Review Commit (decisions saved). */
    reviewedAt:    timestamp("reviewed_at", { withTimezone: true })
  },
  (t) => ({
    tenantStatusIdx: index("idx_enrich_prop_tenant_status").on(t.tenantId, t.status, t.createdAt),
    productIdx:      index("idx_enrich_prop_product").on(t.productId)
  })
);

export type EnrichmentProposalRow = typeof enrichmentProposals.$inferSelect;
export type NewEnrichmentProposalRow = typeof enrichmentProposals.$inferInsert;
