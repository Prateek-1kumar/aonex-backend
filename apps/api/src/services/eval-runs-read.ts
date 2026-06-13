// Read side of the eval-run history (enrichment_eval_runs) — powers the Catalog
// Quality Report's "measured on golden set" headline and its regression count.
//
// computeRegression is a PURE function over two runs' per-SKU rows so it can be
// unit-tested without a DB; getQualityEvalSection assembles what the API returns.

import { desc, eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";

/** Per-SKU metrics needed to diff two runs. */
export interface EvalSkuMetric {
  goldenId: string;
  categorizationCorrect: boolean | null;
  completenessAfter: number | null;
  groundingRate: number | null;
  goldAttrHits: number | null;
  goldAttrTotal: number | null;
  /** Per-field grounding/accepted snapshot. */
  fields: { key: string; grounding: string; accepted: boolean }[];
}

export interface RegressionResult {
  /** SKUs that got worse vs the previous run. */
  count: number;
  /** Per-SKU human-readable reasons (capped by the caller for display). */
  details: { goldenId: string; reasons: string[] }[];
}

// Higher = more trustworthy. A drop down this ladder for a field is a regression.
const GROUNDING_RANK: Record<string, number> = {
  grounded: 4,
  weak: 3,
  inferred: 2,
  unverified: 1,
  contradicted: 0,
};
const rank = (g: string): number => GROUNDING_RANK[g] ?? 2;

const COMPLETENESS_EPS = 0.5; // 0..100 scale; ignore float noise
const RATIO_EPS = 1e-6;

/**
 * Count SKUs present in BOTH runs that regressed: categorization flipped
 * correct→incorrect, completeness dropped beyond epsilon, a field's grounding
 * slipped down the hierarchy, or the gold-attr hit ratio dropped. New SKUs (not in
 * prev) are never counted — only true regressions.
 */
export function computeRegression(prev: EvalSkuMetric[], curr: EvalSkuMetric[]): RegressionResult {
  const prevById = new Map(prev.map((s) => [s.goldenId, s]));
  const details: { goldenId: string; reasons: string[] }[] = [];

  for (const c of curr) {
    const p = prevById.get(c.goldenId);
    if (!p) continue; // newly added SKU — not a regression
    const reasons: string[] = [];

    if (p.categorizationCorrect && !c.categorizationCorrect) {
      reasons.push("categorization flipped correct→incorrect");
    }
    if ((p.completenessAfter ?? 0) - (c.completenessAfter ?? 0) > COMPLETENESS_EPS) {
      reasons.push(`completeness ${p.completenessAfter}→${c.completenessAfter}`);
    }
    const prevRatio = p.goldAttrTotal ? (p.goldAttrHits ?? 0) / p.goldAttrTotal : null;
    const currRatio = c.goldAttrTotal ? (c.goldAttrHits ?? 0) / c.goldAttrTotal : null;
    if (prevRatio !== null && currRatio !== null && prevRatio - currRatio > RATIO_EPS) {
      reasons.push("gold-attr accuracy dropped");
    }
    const prevFields = new Map(p.fields.map((f) => [f.key, f]));
    for (const cf of c.fields) {
      const pf = prevFields.get(cf.key);
      if (pf && rank(pf.grounding) > rank(cf.grounding)) {
        reasons.push(`${cf.key} grounding ${pf.grounding}→${cf.grounding}`);
        break; // one grounding-slip reason per SKU is enough to flag it
      }
    }

    if (reasons.length > 0) details.push({ goldenId: c.goldenId, reasons });
  }

  return { count: details.length, details };
}

/** The latest N eval runs, newest first. */
export async function getLatestRuns(db: DrizzleClient, n = 2): Promise<(typeof schema.enrichmentEvalRuns.$inferSelect)[]> {
  return db.select().from(schema.enrichmentEvalRuns).orderBy(desc(schema.enrichmentEvalRuns.createdAt)).limit(n);
}

async function getRunSkus(db: DrizzleClient, runId: string): Promise<EvalSkuMetric[]> {
  const rows = await db.select().from(schema.enrichmentEvalRunSkus).where(eq(schema.enrichmentEvalRunSkus.runId, runId));
  return rows.map((r) => ({
    goldenId: r.goldenId,
    categorizationCorrect: r.categorizationCorrect,
    completenessAfter: r.completenessAfter,
    groundingRate: r.groundingRate,
    goldAttrHits: r.goldAttrHits,
    goldAttrTotal: r.goldAttrTotal,
    fields: Array.isArray(r.fields) ? (r.fields as EvalSkuMetric["fields"]) : [],
  }));
}

export interface QualityEvalSection {
  categorization: { precision: number; recall: number; top1: number } | null;
  groundingRate: number | null;
  completenessLift: number | null;
  goldAttrAccuracy: number | null;
  model: string | null;
  asOf: string | null;
  regression: { count: number; sinceLabel: string | null } | null;
}

/** Assemble the eval-derived part of the Catalog Quality Report from the latest
 *  run (headline) + the prior run (regression count). Returns nulls when no run
 *  has been persisted yet, so the UI can show "no eval run yet". */
export async function getQualityEvalSection(db: DrizzleClient): Promise<QualityEvalSection> {
  const runs = await getLatestRuns(db, 2);
  const latest = runs[0];
  if (!latest) {
    return {
      categorization: null,
      groundingRate: null,
      completenessLift: null,
      goldAttrAccuracy: null,
      model: null,
      asOf: null,
      regression: null,
    };
  }

  let regression: QualityEvalSection["regression"] = null;
  const prev = runs[1];
  if (prev) {
    const [currSkus, prevSkus] = await Promise.all([getRunSkus(db, latest.runId), getRunSkus(db, prev.runId)]);
    const r = computeRegression(prevSkus, currSkus);
    regression = { count: r.count, sinceLabel: prev.runLabel ?? null };
  }

  return {
    categorization:
      latest.categorizationPrecision === null && latest.categorizationRecall === null
        ? null
        : {
            precision: latest.categorizationPrecision ?? 0,
            recall: latest.categorizationRecall ?? 0,
            top1: latest.categorizationTop1 ?? 0,
          },
    groundingRate: latest.groundingRate,
    completenessLift: latest.completenessLift,
    goldAttrAccuracy: latest.goldAttrAccuracy,
    model: latest.model,
    asOf: latest.createdAt ? latest.createdAt.toISOString() : null,
    regression,
  };
}
