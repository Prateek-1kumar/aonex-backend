// apps/worker/src/jobs/calibration-refit.ts
import type { CronJob } from "./index.js";
import { sql } from "drizzle-orm";
import type { DrizzleClient } from "@aonex/db";
import { fitIsotonic, type LabeledSample, type IsotonicModel } from "@aonex/calibration";

const WINDOW_DAYS = 30;
const MIN_SAMPLES_PER_GROUP = 30;

export interface CalibrationGroupKey {
  extractor: string;
  category: string | null;
  sourceType: string;
}

export interface FittedCalibration {
  key: CalibrationGroupKey;
  sampleCount: number;
  model: IsotonicModel;
}

export interface CalibrationRefitResult {
  groupsExamined: number;
  groupsFitted: number;
  groupsSkippedBelowMin: number;
  fitted: FittedCalibration[];
}

export interface CalibrationRefitDeps {
  db: DrizzleClient;
  /** Override for tests — defaults to MIN_SAMPLES_PER_GROUP */
  minSamplesPerGroup?: number;
  /** Override for tests — defaults to WINDOW_DAYS */
  windowDays?: number;
}

/**
 * Spec §14.3 — weekly cron. Pulls per-fact (raw_confidence, outcome) samples
 * from the past N days where outcome is derived from the approval status of
 * the parent proposed_diff. Fits an isotonic regression per (extractor ×
 * category × source-type) group. Outputs are LOGGED only — storage to a
 * calibration_models table is a Phase 8.1 follow-up.
 */
export async function runCalibrationRefit(deps: CalibrationRefitDeps): Promise<CalibrationRefitResult> {
  const minSamples = deps.minSamplesPerGroup ?? MIN_SAMPLES_PER_GROUP;
  const windowDays = deps.windowDays ?? WINDOW_DAYS;

  const rows = await deps.db.execute(sql`
    SELECT
      er.extractor_version AS extractor,
      pv.canonical_category AS category,
      sa.source_type AS source_type,
      ef.confidence::float8 AS raw_confidence,
      CASE WHEN pd.status IN ('approved', 'auto_approved') THEN 1 ELSE 0 END AS outcome
    FROM extracted_facts ef
    JOIN extracted_fact_sets efs ON efs.id = ef.fact_set_id
    JOIN extraction_runs er ON er.id = efs.extraction_run_id
    JOIN source_artifacts sa ON sa.id = er.artifact_id
    JOIN proposed_diffs pd ON pd.source_fact_set_id = efs.id
    LEFT JOIN product_versions pv ON pv.proposed_diff_id = pd.id
    WHERE pd.status IN ('approved', 'auto_approved', 'rejected')
      AND ef.confidence IS NOT NULL
      AND pd.created_at > now() - (${windowDays} * interval '1 day')
  `);

  const groups = new Map<string, { key: CalibrationGroupKey; samples: LabeledSample[] }>();
  for (const r of rows as unknown as Array<{
    extractor: string;
    category: string | null;
    source_type: string;
    raw_confidence: number;
    outcome: 0 | 1;
  }>) {
    const key: CalibrationGroupKey = {
      extractor: r.extractor,
      category: r.category,
      sourceType: r.source_type
    };
    const keyStr = `${key.extractor}::${key.category ?? "_"}::${key.sourceType}`;
    if (!groups.has(keyStr)) groups.set(keyStr, { key, samples: [] });
    groups.get(keyStr)!.samples.push({
      rawConfidence: Number(r.raw_confidence),
      outcome: r.outcome === 1 ? 1 : 0
    });
  }

  const result: CalibrationRefitResult = {
    groupsExamined: groups.size,
    groupsFitted: 0,
    groupsSkippedBelowMin: 0,
    fitted: []
  };

  for (const { key, samples } of groups.values()) {
    if (samples.length < minSamples) {
      result.groupsSkippedBelowMin++;
      continue;
    }
    const model = fitIsotonic(samples);
    result.fitted.push({ key, sampleCount: samples.length, model });
    result.groupsFitted++;
  }

  return result;
}

export const calibrationRefit: CronJob = {
  name: "calibration-refit",
  cronSchedule: "0 4 * * 0",    // weekly Sunday 04:00 UTC
  async process(ctx) {
    const result = await runCalibrationRefit({ db: ctx.db });
    // eslint-disable-next-line no-console
    console.info("[calibration-refit]", JSON.stringify({
      groupsExamined: result.groupsExamined,
      groupsFitted: result.groupsFitted,
      groupsSkipped: result.groupsSkippedBelowMin,
      // Don't log the full model arrays (can be large); summarize
      fittedSummary: result.fitted.map((f) => ({
        ...f.key,
        sampleCount: f.sampleCount,
        modelSteps: f.model.values.length
      }))
    }));
  }
};
