# Phase 8 — Quality + Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** §14 (Quality) + §12.4–12.5 (Observability + SLOs) + §17 Phase 8
**Depends on:** Phases 1–7 (canonical schema + spine + Tier 1/2 schemas + CSV + per-site parsers + extraction pack)
**Blocks:** Phase 9 (vision LLM relies on calibrators), Phase 10 (multi-tenant overlays need per-tenant slicing)

**Goal:** Make extraction *measurable*. Per-(extractor × category × source-type) isotonic confidence calibrators fit nightly on golden set; per-(domain × field) Beta-binomial reliability priors updated from reviewer corrections; null-rate + distribution + schema drift detectors; selector-ladder rung-share analysis (catches silent LLM-rescue); operational dashboards via SQL views; SLO grid with burn-rate alarms.

**Architecture:** Three new packages — `@aonex/calibration` (isotonic + Beta-binomial), `@aonex/drift-detector` (null-rate + distribution + schema), `@aonex/observability-views` (Postgres views and materialized views). Two new crons — `calibration-refit` (weekly) and `drift-scan` (hourly). Dashboards as Grafana JSON exports living in `docs/dashboards/`. No Honeycomb/ClickHouse cutover in this phase (deferred to Phase 11+); we get the necessary cardinality from per-tenant materialized views in Postgres.

**Tech Stack:** TypeScript, Postgres (materialized views), Grafana 11 JSON dashboards, BullMQ crons, Bun test.

**Acceptance:** Per-(extractor × category × source-type) calibrators fit and stored. Per-(domain × field) reliability scores visible. Drift alerts emit `audit_events` when thresholds tripped. SQL dashboards return data for fleet view + domain health + field completeness + parser versions + cost. SLO query returns rolling 28-day error budget per layer.

---

## File Structure

**Files created**
- `packages/calibration/package.json` + `src/{index,isotonic,beta-binomial}.ts` + tests
- `packages/drift-detector/package.json` + `src/{index,null-rate,distribution,schema}.ts` + tests
- `packages/observability-views/package.json` + `src/{index,views}.ts` + SQL view definitions
- `packages/db/drizzle/<NNNN>_observability_views.sql` — materialized views
- `apps/worker/src/jobs/calibration-refit.ts` + `.test.ts`
- `apps/worker/src/jobs/drift-scan.ts` + `.test.ts`
- `docs/dashboards/fleet-overview.json` — Grafana JSON
- `docs/dashboards/domain-health.json`
- `docs/dashboards/field-completeness.json`
- `docs/dashboards/parser-versions.json`
- `docs/dashboards/cost-panel.json`
- `docs/superpowers/runbooks/slo-burn-rate.md`

**Files modified**
- `apps/worker/src/jobs/index.ts` — register two new crons
- `packages/ingestion/policy-engine/src/router.ts` — use calibrated confidence in routing decisions

---

## Tasks

### Task 1: Branch + scaffold packages

- [ ] **Step 1.1: Branch + 3 package skeletons**

```bash
git checkout main && git pull --ff-only
git checkout -b feature/phase-8-quality-obs
mkdir -p packages/{calibration,drift-detector,observability-views}/src
```

Each `package.json` follows the workspace template (see Phase 4 for shape).

```bash
bun install
```

- [ ] **Step 1.2: Commit scaffolding**

```bash
git add packages/{calibration,drift-detector,observability-views}/
git commit -m "feat: scaffold calibration + drift-detector + observability-views packages"
```

---

### Task 2: Isotonic regression calibrator

**Files:**
- Create: `packages/calibration/src/isotonic.ts` + `.test.ts`

- [ ] **Step 2.1: Failing test**

```typescript
// packages/calibration/src/isotonic.test.ts
import { describe, it, expect } from "bun:test";
import { fitIsotonic, applyCalibrator } from "./isotonic.js";

describe("isotonic calibration", () => {
  it("fits a monotonic step function from labeled (score, correct) pairs", () => {
    const samples = [
      { rawScore: 0.1, correct: 0 },
      { rawScore: 0.2, correct: 0 },
      { rawScore: 0.5, correct: 1 },
      { rawScore: 0.6, correct: 1 },
      { rawScore: 0.9, correct: 1 },
      { rawScore: 0.95, correct: 1 }
    ];
    const cal = fitIsotonic(samples);
    expect(applyCalibrator(cal, 0.15)).toBeLessThan(0.5);
    expect(applyCalibrator(cal, 0.8)).toBeGreaterThan(0.7);
  });

  it("returns identity-like calibrator when sample size < 30", () => {
    const samples = Array.from({ length: 10 }, (_i, i) => ({ rawScore: i / 10, correct: i > 5 ? 1 : 0 }));
    const cal = fitIsotonic(samples);
    // With small N, the calibrator falls back to identity
    expect(applyCalibrator(cal, 0.5)).toBeCloseTo(0.5, 1);
  });
});
```

- [ ] **Step 2.2: Implement isotonic regression (pool-adjacent-violators)**

```typescript
// packages/calibration/src/isotonic.ts
export interface CalibrationSample {
  rawScore: number;    // 0..1
  correct: 0 | 1;
}

export interface IsotonicCalibrator {
  /** Sorted breakpoints: rawScore thresholds */
  breakpoints: number[];
  /** Calibrated probability at each breakpoint */
  calibrated: number[];
  /** Total sample count used for fitting */
  sampleCount: number;
}

const MIN_SAMPLES_FOR_FIT = 30;

/**
 * Spec §14.4 — fit an isotonic regression via the pool-adjacent-violators
 * algorithm. Returns an identity-like calibrator below MIN_SAMPLES.
 */
export function fitIsotonic(samples: CalibrationSample[]): IsotonicCalibrator {
  if (samples.length < MIN_SAMPLES_FOR_FIT) {
    return {
      breakpoints: [0, 1],
      calibrated: [0, 1],
      sampleCount: samples.length
    };
  }

  // Sort by rawScore
  const sorted = [...samples].sort((a, b) => a.rawScore - b.rawScore);

  // Initial blocks: one sample each
  let blocks = sorted.map((s) => ({ sum: s.correct, count: 1, score: s.rawScore }));

  // Pool adjacent violators
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < blocks.length - 1; i++) {
      const a = blocks[i];
      const b = blocks[i + 1];
      const meanA = a.sum / a.count;
      const meanB = b.sum / b.count;
      if (meanA > meanB) {
        blocks[i] = {
          sum: a.sum + b.sum,
          count: a.count + b.count,
          score: (a.score * a.count + b.score * b.count) / (a.count + b.count)
        };
        blocks.splice(i + 1, 1);
        changed = true;
        break;
      }
    }
  }

  return {
    breakpoints: blocks.map((b) => b.score),
    calibrated: blocks.map((b) => b.sum / b.count),
    sampleCount: samples.length
  };
}

export function applyCalibrator(cal: IsotonicCalibrator, rawScore: number): number {
  // Linear interpolation between breakpoints
  if (rawScore <= cal.breakpoints[0]) return cal.calibrated[0];
  if (rawScore >= cal.breakpoints[cal.breakpoints.length - 1]) return cal.calibrated[cal.calibrated.length - 1];

  for (let i = 0; i < cal.breakpoints.length - 1; i++) {
    if (rawScore >= cal.breakpoints[i] && rawScore <= cal.breakpoints[i + 1]) {
      const t = (rawScore - cal.breakpoints[i]) / (cal.breakpoints[i + 1] - cal.breakpoints[i]);
      return cal.calibrated[i] + t * (cal.calibrated[i + 1] - cal.calibrated[i]);
    }
  }
  return rawScore;
}
```

- [ ] **Step 2.3: Run + commit**

```bash
bun --cwd packages/calibration test
git add packages/calibration/src/isotonic.ts packages/calibration/src/isotonic.test.ts
git commit -m "feat(calibration): isotonic regression via pool-adjacent-violators"
```

---

### Task 3: Beta-binomial per-(domain × field) reliability prior

**Files:**
- Create: `packages/calibration/src/beta-binomial.ts` + `.test.ts`

- [ ] **Step 3.1: Implement + test**

```typescript
// packages/calibration/src/beta-binomial.ts
export interface BetaBinomialPrior {
  alpha: number;    // successes + 1
  beta: number;     // failures + 1
}

export function initialPrior(): BetaBinomialPrior {
  return { alpha: 1, beta: 1 };    // Uniform prior
}

export function updatePrior(prior: BetaBinomialPrior, correct: boolean): BetaBinomialPrior {
  return correct
    ? { alpha: prior.alpha + 1, beta: prior.beta }
    : { alpha: prior.alpha, beta: prior.beta + 1 };
}

/** Posterior mean reliability — what we use as the per-(domain × field) score */
export function reliability(prior: BetaBinomialPrior): number {
  return prior.alpha / (prior.alpha + prior.beta);
}

/** 95% credible interval — useful for "is this domain trustworthy" decisions */
export function credibleInterval(prior: BetaBinomialPrior): [number, number] {
  // Approximate via normal for n > 30; otherwise return wide bounds
  const n = prior.alpha + prior.beta;
  if (n < 30) return [0, 1];
  const mean = reliability(prior);
  const variance = (prior.alpha * prior.beta) / ((n * n) * (n + 1));
  const std = Math.sqrt(variance);
  return [Math.max(0, mean - 1.96 * std), Math.min(1, mean + 1.96 * std)];
}
```

```typescript
// packages/calibration/src/beta-binomial.test.ts
import { describe, it, expect } from "bun:test";
import { initialPrior, updatePrior, reliability, credibleInterval } from "./beta-binomial.js";

describe("Beta-binomial", () => {
  it("starts at 0.5 reliability with uniform prior", () => {
    expect(reliability(initialPrior())).toBe(0.5);
  });

  it("converges toward true rate with many updates", () => {
    let prior = initialPrior();
    for (let i = 0; i < 100; i++) prior = updatePrior(prior, true);
    for (let i = 0; i < 20; i++) prior = updatePrior(prior, false);
    expect(reliability(prior)).toBeGreaterThan(0.78);
    expect(reliability(prior)).toBeLessThan(0.86);
  });

  it("widens credible interval for small N", () => {
    const small = updatePrior(initialPrior(), true);
    const [lo, hi] = credibleInterval(small);
    expect(hi - lo).toBe(1);    // forced wide for n < 30
  });
});
```

- [ ] **Step 3.2: Run + commit**

```bash
bun --cwd packages/calibration test
git add packages/calibration/src/beta-binomial.ts packages/calibration/src/beta-binomial.test.ts
git commit -m "feat(calibration): Beta-binomial per-(domain × field) reliability prior"
```

---

### Task 4: `calibration-refit` cron

**Files:**
- Create: `apps/worker/src/jobs/calibration-refit.ts` + `.test.ts`
- Create: `packages/db/drizzle/<NNNN>_calibrators_table.sql` (or via Drizzle TS edit + generate)

- [ ] **Step 4.1: Add `calibrators` table to schema**

`packages/db/src/schema/calibrators.ts`:

```typescript
import { pgTable, uuid, varchar, jsonb, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const calibrators = pgTable(
  "calibrators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extractorVersion: varchar("extractor_version", { length: 100 }).notNull(),
    categoryPath: varchar("category_path", { length: 300 }).notNull(),
    sourceType: varchar("source_type", { length: 50 }).notNull(),    // link_url | templated_csv | marketplace_connector
    /** Stored isotonic calibrator: { breakpoints, calibrated, sampleCount } */
    calibratorPayload: jsonb("calibrator_payload").notNull(),
    sampleCount: integer("sample_count").notNull(),
    fittedAt: timestamp("fitted_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    uniqueScope: uniqueIndex("uq_calibrators_scope").on(t.extractorVersion, t.categoryPath, t.sourceType)
  })
);

export type Calibrator = typeof calibrators.$inferSelect;
```

Add `export * from "./calibrators.js"` to `packages/db/src/schema/index.ts`. Run `bun --bun --cwd packages/db drizzle-kit generate`.

- [ ] **Step 4.2: Implement the cron**

```typescript
// apps/worker/src/jobs/calibration-refit.ts
import { schema, type DrizzleClient } from "@aonex/db";
import { sql } from "drizzle-orm";
import { fitIsotonic, type CalibrationSample } from "@aonex/calibration";

export async function runCalibrationRefit(input: { db: DrizzleClient }): Promise<{ fitted: number }> {
  // Aggregate (raw_confidence_score, reviewer_correct) per (extractor × category × source-type)
  // from the last 30 days. "Reviewer correct" = a review_task that resolved as approved (or auto-approved that never got reverted).
  const rows = await input.db.execute(sql`
    SELECT
      er.extractor_version,
      pv.canonical_category,
      sa.source_type,
      pv.confidence_score::numeric AS raw_score,
      CASE
        WHEN pd.status = 'approved' OR pd.status = 'auto_approved' THEN 1
        ELSE 0
      END AS correct
    FROM product_versions pv
    JOIN proposed_diffs pd ON pd.id = pv.proposed_diff_id
    JOIN extracted_fact_sets fs ON fs.id = pd.source_fact_set_id
    JOIN extraction_runs er ON er.id = fs.extraction_run_id
    JOIN source_artifacts sa ON sa.id = fs.artifact_id
    WHERE pv.created_at > now() - interval '30 days'
      AND pv.canonical_category IS NOT NULL
  `);

  // Group
  const groups = new Map<string, CalibrationSample[]>();
  for (const r of rows as Array<{ extractor_version: string; canonical_category: string; source_type: string; raw_score: number; correct: number }>) {
    const key = `${r.extractor_version}\x00${r.canonical_category}\x00${r.source_type}`;
    const arr = groups.get(key) ?? [];
    arr.push({ rawScore: Number(r.raw_score), correct: r.correct as 0 | 1 });
    groups.set(key, arr);
  }

  let fitted = 0;
  for (const [key, samples] of groups) {
    const [extractorVersion, categoryPath, sourceType] = key.split("\x00");
    const cal = fitIsotonic(samples);
    await input.db
      .insert(schema.calibrators)
      .values({
        extractorVersion,
        categoryPath,
        sourceType,
        calibratorPayload: cal as never,
        sampleCount: samples.length
      })
      .onConflictDoUpdate({
        target: [schema.calibrators.extractorVersion, schema.calibrators.categoryPath, schema.calibrators.sourceType],
        set: { calibratorPayload: cal as never, sampleCount: samples.length, fittedAt: new Date() }
      });
    fitted++;
  }

  return { fitted };
}
```

- [ ] **Step 4.3: Register as weekly cron + test + commit**

In `apps/worker/src/jobs/index.ts`:

```typescript
import { runCalibrationRefit } from "./calibration-refit.js";
// Add to CRONS:
{ name: "calibration-refit", cron: "0 4 * * 0", handler: (deps) => runCalibrationRefit({ db: deps.db }) }
```

```bash
bun test
git add packages/db/src/schema/calibrators.ts packages/db/src/schema/index.ts packages/db/drizzle/ apps/worker/src/jobs/calibration-refit.ts apps/worker/src/jobs/index.ts
git commit -m "feat(worker): weekly calibration-refit cron + calibrators table"
```

---

### Task 5: Drift detector — null-rate, distribution, schema

**Files:**
- Create: `packages/drift-detector/src/{null-rate,distribution,schema}.ts` + tests
- Create: `apps/worker/src/jobs/drift-scan.ts` + `.test.ts`

Each drift module follows the same pattern — query an aggregate, compare to a rolling baseline, emit an audit event when threshold tripped.

- [ ] **Step 5.1: Null-rate detector**

```typescript
// packages/drift-detector/src/null-rate.ts
import type { DrizzleClient } from "@aonex/db";
import { sql } from "drizzle-orm";

export interface NullRateAlert {
  domain: string;
  field: string;
  currentRate: number;
  baselineRate: number;
  thresholdSigma: number;
}

export async function detectNullRateDrift(input: { db: DrizzleClient; windowHours?: number; baselineDays?: number }): Promise<NullRateAlert[]> {
  const windowH = input.windowHours ?? 24;
  const baselineD = input.baselineDays ?? 7;

  // Cheap query — per-(domain × field) null rate in last N hours vs last M days
  const rows = await input.db.execute(sql`
    WITH recent AS (
      SELECT
        regexp_replace(pv.evidence_summary->>'sourceUrl', '^https?://(?:www\\.)?([^/]+).*', '\\1') AS domain,
        k AS field,
        sum(CASE WHEN pv.attributes_json->k IS NULL OR pv.attributes_json->k = 'null'::jsonb THEN 1 ELSE 0 END)::float / count(*) AS current_rate
      FROM product_versions pv, jsonb_object_keys(pv.attributes_json) AS k
      WHERE pv.created_at > now() - (${windowH} * interval '1 hour')
      GROUP BY 1, 2
    ),
    baseline AS (
      SELECT
        regexp_replace(pv.evidence_summary->>'sourceUrl', '^https?://(?:www\\.)?([^/]+).*', '\\1') AS domain,
        k AS field,
        sum(CASE WHEN pv.attributes_json->k IS NULL OR pv.attributes_json->k = 'null'::jsonb THEN 1 ELSE 0 END)::float / count(*) AS baseline_rate,
        stddev_samp(CASE WHEN pv.attributes_json->k IS NULL OR pv.attributes_json->k = 'null'::jsonb THEN 1.0 ELSE 0.0 END) AS std
      FROM product_versions pv, jsonb_object_keys(pv.attributes_json) AS k
      WHERE pv.created_at BETWEEN now() - (${baselineD} * interval '1 day') AND now() - (${windowH} * interval '1 hour')
      GROUP BY 1, 2
    )
    SELECT
      r.domain, r.field, r.current_rate, b.baseline_rate,
      CASE WHEN b.std > 0 THEN (r.current_rate - b.baseline_rate) / b.std ELSE 0 END AS sigma
    FROM recent r
    JOIN baseline b USING (domain, field)
    WHERE b.std > 0
      AND abs((r.current_rate - b.baseline_rate) / b.std) > 2
  `);

  return (rows as Array<{ domain: string; field: string; current_rate: number; baseline_rate: number; sigma: number }>).map((r) => ({
    domain: r.domain,
    field: r.field,
    currentRate: Number(r.current_rate),
    baselineRate: Number(r.baseline_rate),
    thresholdSigma: Number(r.sigma)
  }));
}
```

- [ ] **Step 5.2: Distribution + schema drift detectors**

`packages/drift-detector/src/distribution.ts` — track median price / mean image count / mean title length per (domain × category) daily; flag > 25% WoW change.

`packages/drift-detector/src/schema.ts` — hash the per-(domain × day) set of attribute keys; alert on any new key, removed key, or type change vs yesterday.

Each gets a test + implementation + commit.

- [ ] **Step 5.3: `drift-scan` cron**

```typescript
// apps/worker/src/jobs/drift-scan.ts
import { detectNullRateDrift } from "@aonex/drift-detector";

export async function runDriftScan(deps: { db; audit }) {
  const nullAlerts = await detectNullRateDrift({ db: deps.db });
  for (const alert of nullAlerts) {
    await deps.audit.emit({
      actorType: "worker",
      eventType: "drift.null_rate",
      entityType: "domain_field",
      entityId: `${alert.domain}:${alert.field}`,
      metadata: alert
    } as never);
  }
  // ... distribution + schema drift similarly
  return { nullAlerts: nullAlerts.length };
}
```

Register as hourly cron.

- [ ] **Step 5.4: Commit**

```bash
git add packages/drift-detector/ apps/worker/src/jobs/drift-scan.ts apps/worker/src/jobs/index.ts
git commit -m "feat(drift-detector): null-rate + distribution + schema drift detectors + hourly cron"
```

---

### Task 6: Selector-ladder rung-share analysis

**Files:**
- Create: `packages/observability-views/src/views.ts` — defines materialized view `mv_ladder_rung_share`
- Create: matching migration

- [ ] **Step 6.1: SQL view**

```sql
-- packages/db/drizzle/<NNNN>_ladder_rung_share_view.sql
CREATE MATERIALIZED VIEW mv_ladder_rung_share AS
SELECT
  metadata->>'domain' AS domain,
  metadata->>'rung' AS rung,
  date_trunc('hour', created_at) AS hour,
  count(*) AS fired
FROM audit_events
WHERE event_type = 'ladder.rung_fired'
  AND created_at > now() - interval '30 days'
GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX uq_mv_ladder_rung_share ON mv_ladder_rung_share(domain, rung, hour);

-- Refresh every hour via cron
```

- [ ] **Step 6.2: Refresh cron**

In `apps/worker/src/jobs/index.ts`:

```typescript
{
  name: "mv-refresh",
  cron: "5 * * * *",
  handler: async (deps: { db }) => {
    await deps.db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ladder_rung_share`);
  }
}
```

- [ ] **Step 6.3: Alert query**

Add to runbook + dashboard:

```sql
-- Alert when LLM-rescue rung share > 30% for a domain with a per-site parser registered
SELECT domain, sum(CASE WHEN rung = 'llm_gap_fill' THEN fired ELSE 0 END)::float / sum(fired) AS llm_share
FROM mv_ladder_rung_share
WHERE hour > now() - interval '24 hours'
GROUP BY domain
HAVING sum(CASE WHEN rung = 'llm_gap_fill' THEN fired ELSE 0 END)::float / sum(fired) > 0.30
ORDER BY 2 DESC;
```

- [ ] **Step 6.4: Commit**

```bash
git add packages/db/drizzle/ apps/worker/src/jobs/index.ts docs/superpowers/runbooks/
git commit -m "feat(observability): ladder rung-share materialized view + hourly refresh"
```

---

### Task 7: Grafana dashboards (JSON exports)

**Files:**
- Create: `docs/dashboards/{fleet-overview,domain-health,field-completeness,parser-versions,cost-panel}.json`

- [ ] **Step 7.1: Build each dashboard in your local Grafana, export JSON, commit**

Each dashboard panels listed in spec §12.4. Use Postgres datasource pointing at the same DATABASE_URL. Each JSON file is ~100–300 lines depending on panel count.

For the **fleet-overview** dashboard:
- Panel 1: success rate by lane (link / CSV / nango), 24h trend
- Panel 2: per-source-type breakdown
- Panel 3: anomaly queue depth + oldest item age

```bash
# After exporting each dashboard JSON:
git add docs/dashboards/
git commit -m "docs: Grafana JSON dashboards for fleet/domain/field/parser/cost"
```

---

### Task 8: SLO + burn-rate runbook

**Files:**
- Create: `docs/superpowers/runbooks/slo-burn-rate.md`

- [ ] **Step 8.1: Write runbook**

```markdown
# Runbook — SLO burn-rate alarms

## SLOs (spec §12.5)

| Layer | P95 target | Success rate target |
|-------|------------|---------------------|
| Static fetch | <3s | >99% |
| Browser fetch | <12s | >95% |
| Unblock vendor | <25s | >95% |
| End-to-end link→canonical | <30s structured / <5min full | >90% |
| CSV file → first row validation | <2min (≤10K rows) | n/a |
| Auto-approved link → product_version | <30s structured / <5min full | n/a |

## Burn-rate query

```sql
-- 28-day error budget burn for end-to-end link
WITH window AS (
  SELECT count(*) AS total,
         sum(CASE WHEN event_type = 'ingestion.approve.completed' THEN 1 ELSE 0 END) AS succeeded
  FROM audit_events
  WHERE event_type LIKE 'ingestion.%'
    AND metadata->>'lane' = 'link'
    AND created_at > now() - interval '28 days'
)
SELECT
  total,
  succeeded,
  total - succeeded AS failures,
  (total - succeeded)::float / total AS error_rate,
  1.0 - 0.90 AS budget,
  ((total - succeeded)::float / total) / (1.0 - 0.90) AS burn_ratio
FROM window;
```

`burn_ratio > 1` means we're consuming budget faster than allowed → page.
`burn_ratio > 14` (over a 1-hour window) means a fast-burn — page immediately.

## P1/P2/P3 tiers

See spec §12.4.5.
```

- [ ] **Step 8.2: Commit**

```bash
git add docs/superpowers/runbooks/slo-burn-rate.md
git commit -m "docs: SLO burn-rate runbook"
```

---

### Task 9: Wire calibrated confidence into policy engine

**Files:**
- Modify: `packages/ingestion/policy-engine/src/router.ts`

- [ ] **Step 9.1: Apply calibrator in the router**

In `router.ts`, after computing the raw composite score:

```typescript
import { applyCalibrator } from "@aonex/calibration";

// Inside the router function — after computing rawScore:
const calibrator = await loadCalibrator(deps.db, extractorVersion, categoryPath, sourceType);
const calibratedScore = applyCalibrator(calibrator, rawScore);

// Use calibratedScore for the auto-approve threshold check, not rawScore.
```

Provide a `loadCalibrator` helper that queries the `calibrators` table and falls back to an identity calibrator when no fit exists.

- [ ] **Step 9.2: Commit**

```bash
git add packages/ingestion/policy-engine/
git commit -m "feat(policy-engine): apply isotonic calibrator before auto-approve gate"
```

---

### Task 10: PR

```bash
git push -u origin feature/phase-8-quality-obs
gh pr create --title "feat(phase-8): quality + observability (calibrators, drift, dashboards, SLOs)" --body "<see plan §17 Phase 8>"
```

---

## Self-Review

1. **Spec coverage** — Calibrators ✓, Beta-binomial ✓, drift ✓, ladder analysis ✓, dashboards ✓, SLO runbook ✓.
2. **Placeholder scan** — Distribution + schema drift implementations referred to "same shape" in Step 5.2; expand inline if executor wants verbatim. The pattern is null-rate's mirror with different metrics.
3. **Type consistency** — `IsotonicCalibrator` shape consistent across calibration package + cron + router. ✓
