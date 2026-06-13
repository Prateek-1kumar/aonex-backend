// Eval-run history — one row per enrichment/taxonomy eval run (aggregate metrics)
// plus one row per golden SKU in that run (per-SKU detail for the regression diff).
// Written by scripts/eval/run-enrichment-eval.ts --persist; read by the quality API.

import { pgTable, uuid, text, integer, boolean, doublePrecision, jsonb, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const enrichmentEvalRuns = pgTable(
  "enrichment_eval_runs",
  {
    runId:                   uuid("run_id").primaryKey().defaultRandom(),
    /** Human label for the run (git sha, or a manual tag). */
    runLabel:                text("run_label"),
    model:                   text("model"),
    nProducts:               integer("n_products").notNull().default(0),
    categorizationPrecision: doublePrecision("categorization_precision"),
    categorizationRecall:    doublePrecision("categorization_recall"),
    categorizationTop1:      doublePrecision("categorization_top1"),
    groundingRate:           doublePrecision("grounding_rate"),
    completenessBefore:      doublePrecision("completeness_before"),
    completenessAfter:       doublePrecision("completeness_after"),
    completenessLift:        doublePrecision("completeness_lift"),
    goldAttrAccuracy:        doublePrecision("gold_attr_accuracy"),
    contentGroundingRate:    doublePrecision("content_grounding_rate"),
    createdAt:               timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ createdIdx: index("idx_eval_runs_created").on(t.createdAt) })
);

export const enrichmentEvalRunSkus = pgTable(
  "enrichment_eval_run_skus",
  {
    runId:                 uuid("run_id")
      .notNull()
      .references(() => enrichmentEvalRuns.runId, { onDelete: "cascade" }),
    goldenId:              text("golden_id").notNull(),
    nodeId:                text("node_id"),
    predictedNodeId:       text("predicted_node_id"),
    categorizationCorrect: boolean("categorization_correct"),
    completenessAfter:     doublePrecision("completeness_after"),
    groundingRate:         doublePrecision("grounding_rate"),
    goldAttrHits:          integer("gold_attr_hits"),
    goldAttrTotal:         integer("gold_attr_total"),
    /** Per-field [{ key, grounding, accepted }] — the regression diff reads this. */
    fields:                jsonb("fields").notNull().default(sql`'[]'::jsonb`),
  },
  (t) => ({
    pk:        primaryKey({ columns: [t.runId, t.goldenId] }),
    goldenIdx: index("idx_eval_run_skus_golden").on(t.goldenId),
  })
);

export type EnrichmentEvalRunRow = typeof enrichmentEvalRuns.$inferSelect;
export type NewEnrichmentEvalRunRow = typeof enrichmentEvalRuns.$inferInsert;
export type EnrichmentEvalRunSkuRow = typeof enrichmentEvalRunSkus.$inferSelect;
export type NewEnrichmentEvalRunSkuRow = typeof enrichmentEvalRunSkus.$inferInsert;
