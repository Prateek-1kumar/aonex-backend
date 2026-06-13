-- Enrichment/taxonomy eval-run history — the data behind the Catalog Quality
-- Report's "measured on golden set" headline and its regression count.
--
-- One row per eval run (aggregate metrics) + one row per golden SKU in that run
-- (enough per-SKU detail to diff the latest two runs and count regressions:
-- categorization flips, completeness drops, grounding-hierarchy slips, gold-attr
-- ratio drops). The eval writes these behind --persist; the quality API reads them.

-- Up Migration
CREATE TABLE enrichment_eval_runs (
  run_id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_label                text,
  model                    text,
  n_products               integer NOT NULL DEFAULT 0,
  categorization_precision double precision,
  categorization_recall    double precision,
  categorization_top1      double precision,
  grounding_rate           double precision,
  completeness_before      double precision,
  completeness_after       double precision,
  completeness_lift        double precision,
  gold_attr_accuracy       double precision,
  content_grounding_rate   double precision,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_eval_runs_created ON enrichment_eval_runs (created_at DESC);

CREATE TABLE enrichment_eval_run_skus (
  run_id                 uuid NOT NULL REFERENCES enrichment_eval_runs(run_id) ON DELETE CASCADE,
  golden_id              text NOT NULL,
  node_id                text,
  predicted_node_id      text,
  categorization_correct boolean,
  completeness_after     double precision,
  grounding_rate         double precision,
  gold_attr_hits         integer,
  gold_attr_total        integer,
  fields                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (run_id, golden_id)
);
CREATE INDEX idx_eval_run_skus_golden ON enrichment_eval_run_skus (golden_id);

-- Down Migration
DROP TABLE IF EXISTS enrichment_eval_run_skus;
DROP TABLE IF EXISTS enrichment_eval_runs;
