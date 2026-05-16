# Runbook — Ingestion spine shadow mode (Phase 2 → Phase 6 cutover)

## Current state

The spine ships behind two env-vars (both default `false`):
- `INGESTION_SPINE_ENABLED` — when `true`, the legacy `link-extract.processor.ts`
  dispatches every job to the spine's `runSpineLink` at the top of the handler.
- `INGESTION_SPINE_SHADOW_MODE` — reserved for the shadow-compare driver
  (Phase 6); reading this var has no effect in Phase 2 itself.

The new `QUEUE.INGESTION_SPINE` worker is wired in `composition-root.ts` but
no producer enqueues to it yet — CSV/Nango lanes will use it directly from
Phase 4 onward. In Phase 2, the spine runs INSIDE the legacy queue worker
via the env-flag dispatch above.

The shadow-compare utility `apps/worker/src/services/shadow-compare.ts`
exports `compareCanonicalRows(legacy, spine)` returning `{ differingFields,
diffRatio }`. The actual rollout wiring (running both pipelines in parallel
and persisting only the legacy result, emitting `shadow.diff_detected`
events) is **Phase 6** work; this runbook documents the eventual cutover.

## Enable shadow mode

```bash
# In .env on staging
INGESTION_SPINE_ENABLED=true
INGESTION_SPINE_SHADOW_MODE=true
```

In shadow mode, both pipelines run; the spine result is logged but the
legacy result is the one persisted. `compareCanonicalRows()` writes
diff metrics to `audit_events`.

## What this preserves vs. legacy

The spine's orchestrator (`packages/ingestion-spine/src/orchestrator.ts`)
explicitly preserves four legacy behaviors that an early plan revision
silently dropped:

1. **`review_tasks` rows** — when the policy router routes to `review`,
   the spine inserts one row per detector signal (with `clusterKey`,
   `signalKind`, `severity`, `policyVersionId`). Without this, the
   reviewer queue would be empty after cutover.
2. **`proposed_diff_fields` rows** — per-field detail for the reviewer
   UI's field-level approve/reject (via the new `persistDiffFields`
   helper).
3. **Title-presence auto-approve gate** — `shouldAutoApprove = decision.route
   === "auto_approve" && Boolean(attributes.title)`. `applyApprovedDiff`
   throws on missing title, so auto-approving without one would crash.
4. **`categoryRequiredAttributes` threaded into the policy router** — exposed
   from `runValidate` via the new `ValidateStageResult.requiredAttributes`
   field. Without it, the `missing_required_attribute` detector is silently
   disabled.

If the diff rate during shadow mode reveals systematic gaps on any of these
behaviors, **do not cut over** — investigate first.

## Monitor

Query 7-day rolling diff rate by field:

```sql
SELECT metadata->'field' as field, count(*) as diffs
FROM audit_events
WHERE event_type = 'shadow.diff_detected'
  AND created_at > now() - interval '7 days'
GROUP BY 1
ORDER BY 2 DESC;
```

Acceptance: diff rate < 5% on every field in NON_TRIVIAL_FIELDS.

## Per-stage audit trail

Every spine run emits seven `audit_events` rows (one per stage):
- `ingestion.persist_artifact.completed`
- `ingestion.extract.completed`
- `ingestion.map.completed`
- `ingestion.validate.completed`
- `ingestion.score.completed`
- `ingestion.diff.completed`
- `ingestion.approve.completed` (only on auto-approve)

Each event's `metadata` includes the full `StageAuditMeta`:
`lane`, `extractorVersion`, `mapperVersion`, `policyVersion`,
`extractionRunId`, `factSetId`, `productId`, `productVersionId`,
`proposedDiffId`, plus per-stage extras (e.g., `factsCount` on
`extract.completed`, `score`/`route`/`detectorsTripped` on
`score.completed`).

Inspect a single ingestion's trail:

```sql
SELECT
  event_type,
  metadata->>'stage' AS stage,
  metadata->>'route' AS route,
  metadata->>'score' AS score,
  metadata->>'productVersionId' AS pv,
  created_at
FROM audit_events
WHERE entity_id = '<artifact_id>'
  AND event_type LIKE 'ingestion.%'
ORDER BY created_at;
```

If you see fewer than 6 rows for a successful ingestion (or 7 for
auto-approve), an earlier stage threw — check the worker logs.

## Cut over

When 7 days of < 5% parity hold:

```bash
# Stop shadow, route all traffic to spine
INGESTION_SPINE_ENABLED=true
INGESTION_SPINE_SHADOW_MODE=false
```

After another 48 hours of green production, **delete in this order**:

1. `apps/worker/src/services/emit-failure-review-task.ts` references inside
   `link-extract.processor.ts` — verify the spine emits equivalent failure
   review_tasks (the `fetch_failed` / `captcha_wall` signals) BEFORE removing.
2. `apps/worker/src/processors/link-extract.processor.ts` — convert the file
   to a thin re-export of `runSpineLink` so any caller that still
   imports `makeLinkExtractProcessor` keeps working. Or, if no callers
   remain, delete outright.
3. `apps/worker/src/services/link-catalog-pipeline.ts` and its test file.
4. Update `composition-root.ts` to register the spine processor on
   BOTH `QUEUE.LINK_EXTRACT` (for backward compatibility with already-enqueued
   jobs) and `QUEUE.INGESTION_SPINE`.

Do NOT delete `apps/worker/src/services/shadow-compare.ts` — it stays.

## Rollback

```bash
INGESTION_SPINE_ENABLED=false
```

Effective immediately for new jobs; in-flight jobs in the spine queue continue.
