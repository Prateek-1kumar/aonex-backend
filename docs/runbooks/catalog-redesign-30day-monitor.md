# Catalog Redesign 30-Day Monitor Runbook

**When to run.** Phase 8 cutover has completed — legacy tables have been renamed to `_legacy_*` and `CATALOG_USE_NEW_SCHEMA=true` is the only active code path. This runbook covers the 30-day soak window from cutover through Phase 9 entry. Run it daily (five checks) and weekly (two additional checks) until the Day 30 entry criteria are met.

**Authorization required.** No authorization needed to run checks. Escalation (rollback or forward fix) requires on-call eng sign-off. Document all escalations in the Incidents Log section at the bottom of this file.

**Reference:** cutover runbook (Task 8.1, `scripts/cutover.ts`). Phase 9 drop is Tasks 9.1–9.4. Daily check tooling: `apps/worker/scripts/` and `packages/catalog/watchdog/`.

---

## 1. Why this runbook exists

Phase 8 renames the seven legacy tables to `_legacy_*` inside a single atomic transaction. It does NOT drop them. This is intentional: the renamed tables are the rollback insurance. If a regression surfaces in the 30-day window, an operator can reverse the rename (see Section 6) and be back on the legacy path within minutes.

Phase 9 drops the `_legacy_*` tables. That is the point of no return — no snapshot required, no rollback path. The 30-day window exists specifically to catch regressions before Phase 9 is authorized.

The renamed tables are:

| Original name               | Renamed to                         |
|-----------------------------|------------------------------------|
| `products`                  | `_legacy_products`                 |
| `product_versions`          | `_legacy_product_versions`         |
| `product_identities`        | `_legacy_product_identities`       |
| `product_variants`          | `_legacy_product_variants`         |
| `product_variant_versions`  | `_legacy_product_variant_versions` |
| `proposed_diffs`            | `_legacy_proposed_diffs`           |
| `proposed_diff_fields`      | `_legacy_proposed_diff_fields`     |

---

## 2. Daily checks

Run all five checks every day. Record results in the daily pass log (Section 5). All five must be GREEN before you can tick that day's row.

### Check 1: Watchdog drift_rate trend

**What it measures.** The watchdog daily sweep scans every active product and re-projects `winning_values`, `catalog_pricing_current`, and `catalog_inventory_current` from scratch using the same `pickWinner` logic the reconciler uses. A drift hit means a stored winner disagrees with what the reconciler would produce if it ran right now. Sustained drift growth indicates a reconciler bug or data-loss regression introduced after cutover.

**How to check.** Query `catalog_watchdog_log` for the last 24 hours:

```sql
SELECT
  DATE_TRUNC('hour', checked_at)                                AS hour,
  COUNT(*) FILTER (WHERE is_drift)                              AS drift_count,
  COUNT(*)                                                      AS total_count,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE is_drift) / NULLIF(COUNT(*), 0),
    3
  )                                                             AS drift_rate_pct
FROM catalog_watchdog_log
WHERE tenant_id = '<tenant_id>'
  AND checked_at > NOW() - INTERVAL '1 day'
GROUP BY 1
ORDER BY 1 DESC;
```

**Healthy range.** `drift_rate_pct < 0.1` for every hour in the result set.

**Alert threshold.** `drift_rate_pct >= 0.1` in any single hour. If the elevated rate persists across two consecutive hours, escalate immediately.

**Investigation steps.**

1. Pull the specific drifted products for the failing hour:

   ```sql
   SELECT product_id, attr, channel, locale, stored_value, expected_value, checked_at
   FROM catalog_watchdog_log
   WHERE tenant_id = '<tenant_id>'
     AND is_drift = true
     AND checked_at BETWEEN '<hour_start>' AND '<hour_end>'
   ORDER BY checked_at;
   ```

2. For each drifted `product_id`, run the trace script to get full observation history (requires `--tenant-id` and `--merchant-id` — look both up from `catalog_products` if needed):

   ```bash
   bun --env-file=../../.env --cwd apps/worker run scripts/product-debug.ts \
     --product-id <uuid> \
     --tenant-id <uuid> \
     --merchant-id <uuid>
   ```

3. In the trace output, find the observation that should have won for the drifted `attr`/`channel`/`locale`. Check whether the source priority rules changed (`source_priority` table) or whether the observation itself was modified after the watchdog ran.

4. Check whether a reconciler code change was deployed since cutover. A newly deployed reconciler that applies different `pickWinner` semantics will cause transient drift until it re-projects all stale products.

---

### Check 2: Outbox lag (max + p99)

**What it measures.** `catalog_events` rows accumulate when the outbox poller falls behind. Lag count is the number of unpublished rows; p99 age is the 99th-percentile age of those rows. Sustained lag means consumers (webhooks, search index updates) are not receiving events, which can cause downstream stale-data issues visible to customers.

**How to check.** Run all three queries:

```sql
-- Lag count: total unpublished rows.
SELECT COUNT(*) AS lag_count
FROM catalog_events
WHERE published_at IS NULL;

-- Oldest unpublished row (wall-clock age of the head of queue).
SELECT
  MIN(occurred_at)                                  AS oldest_occurred_at,
  EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))    AS oldest_age_seconds
FROM catalog_events
WHERE published_at IS NULL;

-- P99 age of unpublished rows (seconds).
SELECT PERCENTILE_CONT(0.99) WITHIN GROUP (
  ORDER BY EXTRACT(EPOCH FROM (now() - occurred_at))
) AS p99_age_seconds
FROM catalog_events
WHERE published_at IS NULL;
```

**Healthy range.** `lag_count < 10,000` and `p99_age_seconds < 60`.

**Alert threshold.** `lag_count >= 10,000` (the spec §19.1 soft backpressure threshold — the poller activates throttling here) OR `p99_age_seconds > 60` sustained for 5 minutes.

**Investigation steps.**

1. Check the DLQ for failure reasons. Rows in `catalog_events_dlq` indicate events the poller gave up on:

   ```sql
   SELECT failure_reason, COUNT(*) AS count
   FROM catalog_events_dlq
   GROUP BY failure_reason
   ORDER BY count DESC
   LIMIT 20;
   ```

2. Inspect worker poller logs. The poller emits structured log events keyed `poller.cycle_failed`, `poller.cycle_partial`, and `poller.cycle_ok`. Filter for `poller.cycle_failed` and `poller.cycle_partial` in your log aggregator. If you don't have a log aggregator wired, tail the running worker:

   ```bash
   # adjust path to match your worker process log file or pod logs
   tail -f apps/worker/worker.log | grep '"poller\.'
   ```

3. Check whether the Redis Streams subscriber is alive. A dead subscriber stops event delivery downstream even when the poller is marking rows `published_at`. Confirm the worker process is running and the `REDIS_URL` environment variable is correct.

4. Check whether the backpressure signal in Redis is stuck. `getCurrentThrottleSignal` (from `packages/catalog/event-outbox/src/backpressure.ts`) reads a Redis key. If that key holds a throttle level higher than expected, the poller is intentionally slowing down. Investigate why the lag count crossed the threshold in the first place before clearing the signal.

---

### Check 3: Catalog write latency

**What it measures.** The time between an observation arriving at the write path (`writeAdapterOutput`) and the corresponding `catalog_product_revisions` row being created (`ingested_at`) approximates the write pipeline latency. Elevated latency can indicate DB lock contention, advisory lock saturation on the reconciler, or a slow `pickWinner` query.

**How to check.** Run this query for the last hour of revision data:

```sql
SELECT
  PERCENTILE_CONT(0.50) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (ingested_at - occurred_at)) * 1000
  ) AS p50_ms,
  PERCENTILE_CONT(0.99) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (ingested_at - occurred_at)) * 1000
  ) AS p99_ms
FROM catalog_product_revisions
WHERE ingested_at > now() - INTERVAL '1 hour';
```

Note: `occurred_at` is the timestamp the revision row was created (the event that triggered the write); `ingested_at` is when the row was physically written. The difference approximates pipeline latency but does not include the time from observation receipt to the reconciler being scheduled. Treat p99 as a floor, not an exact end-to-end measure.

If your infra ships worker stdout as structured logs, search for `catalog.write.duration_ms` — however, as of Phase 5, write latency is not instrumented as a separate metric. The SQL query above is the authoritative check today.

**Healthy range.** `p99_ms < 200`.

**Alert threshold.** `p99_ms > 500` sustained across a 5-minute observation window (re-run the query 3 times, 90 seconds apart; if all three return p99 > 500, escalate).

**Investigation steps.**

1. Check for DB lock contention. A high `idle in transaction` count on `catalog_products` indicates an advisory lock is being held too long by the reconciler:

   ```sql
   SELECT pid, state, wait_event_type, wait_event, query_start,
          LEFT(query, 120) AS query_head
   FROM pg_stat_activity
   WHERE state != 'idle'
     AND query ILIKE '%catalog_products%'
   ORDER BY query_start;
   ```

2. Profile a slow write by running `EXPLAIN ANALYZE` on the `pickWinner` subquery. The reconciler's `_internal.ts:pickWinner` query reads from `catalog_products` using a per-product advisory lock. A large `source_priority` table or a missing index can cause per-product scan time to spike.

3. Check whether the advisory lock duration has increased. The reconciler holds `pg_advisory_xact_lock(product_id)` for the duration of the write transaction. If the reconciler queue is saturated, multiple workers fight for the same lock. Check BullMQ concurrency settings and consider reducing the reconciler worker pool if contention is the root cause.

---

### Check 4: Error rate per endpoint

**What it measures.** 5xx responses from the API indicate that the new-schema code paths are throwing unhandled errors. Elevated error rates after cutover typically mean the `CATALOG_USE_NEW_SCHEMA` flag is unexpectedly false on one or more pods (environment regression), or a code path that was green during Phase 7 parity tests is failing under production load.

**How to check.** Use your existing log aggregator or APM tool to filter 5xx responses grouped by endpoint. If you don't have a log aggregator:

```bash
# Tail the running API log and filter for 5xx.
# Adjust path or command to match your API process (Docker logs, kubectl logs, etc.).
tail -f apps/api/api.log | grep '"status":5'
```

For endpoints of particular concern after cutover (all new-schema reads/writes):

- `GET /products/:id`
- `GET /products/:id/provenance/:attribute_code`
- `GET /products/:id/trace`
- `POST /products` (ingestion)

**Healthy range.** `< 0.1%` error rate per endpoint over any 5-minute window.

**Alert threshold.** `> 1%` error rate per endpoint sustained for 5 minutes.

**Investigation steps.**

1. Tail logs for the failing endpoint and capture the stack trace. Most 5xx responses from catalog handlers are not swallowed — the error message will identify whether it is a missing row, a JSON parse error, or a DB constraint violation.

2. Confirm `CATALOG_USE_NEW_SCHEMA` is still `true` on all running pods. A deploy that accidentally resets env can flip the flag:

   ```bash
   # If running locally:
   echo $CATALOG_USE_NEW_SCHEMA

   # If running in a container/pod, inspect the running environment:
   # kubectl exec -it <pod> -- printenv CATALOG_USE_NEW_SCHEMA
   ```

   If the flag is `false` on any instance, the API pod is reading legacy tables that have been renamed — every catalog read will 404 or error. Correct the environment and restart.

3. Run the parity test suite against the running environment to confirm the flag-ON path is healthy end-to-end:

   ```bash
   bun --cwd apps/api test src/handlers/catalog.parity.test.ts
   ```

   Expected: 7 pass, 2 skip, 0 fail (the 2 known skips are documented in the Phase 7 runbook).

---

### Check 5: Customer support ticket keywords

**What it measures.** Customer-reported issues are the canary that technical metrics can miss — edge cases in real data, SKUs that are in a tenant's catalog but not in the backfill sample, or channel-specific issues that don't appear in aggregate stats.

**How to check.** Query your support tool (Linear, Zendesk, Intercom, or equivalent) for tickets created in the last 24 hours containing any of these phrases:

- "missing product"
- "wrong price"
- "price mismatch"
- "can't find product"
- "product not showing"

This is operator-tooling-specific. There is no canonical script here — use whatever your team uses to search tickets. The goal is to do this check daily, not wait for someone to escalate manually.

**Healthy range.** Zero keyword-matched tickets per day.

**Alert threshold.** One or more keyword-matched tickets in a day. Treat every ticket as high-priority triage; do not wait for a second ticket.

**Investigation steps.**

1. Obtain the `product_id` from the ticket (ask the customer or look it up via the product's identifier in `catalog_products`).

2. Run the trace script to get full observation + provenance history for the affected product:

   ```bash
   bun --env-file=../../.env --cwd apps/worker run scripts/product-debug.ts \
     --product-id <uuid> \
     --tenant-id <uuid> \
     --merchant-id <uuid>
   ```

3. Check the provenance endpoint for the reported attribute (e.g. `price` or `title`):

   ```
   GET /products/<product_id>/provenance/<attribute_code>
   ```

4. If the problem is a wrong winning value: look at the `winning_values` JSONB in `catalog_products` for the product, compare it against `values` observations, and determine whether `pickWinner` chose the wrong source. Check whether a `source_priority` rule was changed post-cutover.

5. If the product is missing entirely: check whether it exists in `catalog_products` with a non-`merged_into` status. If it does not exist, check `_legacy_products` (still readable) to confirm the product existed before cutover. If it was in `_legacy_products` but not in `catalog_products`, the backfill missed it — investigate the backfill cursor for gaps.

---

## 3. Weekly checks

In addition to the five daily checks, run both of these once per week (same day each week is fine; pick a low-traffic window).

### Week N — Re-run full validation

```bash
bun --env-file=../../.env --cwd apps/worker run scripts/validate-backfill.ts \
  --tenant-id <uuid> \
  --output "backfill-report-week-$(date +%V).json" \
  --strict
```

Required result: `totalFailed === 0` on required fields (`title`, `brand`, `gtin`, `primary_pricing`). Any regression versus the pre-cutover baseline is a blocker. Stop the 30-day window clock and investigate immediately.

### Week N — Spot-check 100 random products

```bash
bun --env-file=../../.env --cwd apps/worker run scripts/spot-check.ts \
  --tenant-id <uuid> \
  --sample-size 100 \
  --output "spot-check-week-$(date +%V).html"
```

Open the HTML report and review the **"Possible losses"** section. Compare against the baseline spot-check from Task 8.1 (or Phase 7 if no Task 8.1 baseline was saved). The set of possible losses should be stable or shrinking. Any new field appearing in the losses section after cutover is a regression and must be triaged with the eng team before proceeding.

---

## 4. Daily pass log

Keep a row per day. All five daily checks must show GREEN before marking the day PASS. Start from Day 1 (cutover day + 1).

| Day | Watchdog drift | Outbox lag | Write latency | Error rate | Support tickets | Notes |
|-----|---------------|------------|---------------|------------|-----------------|-------|
| 1   |               |            |               |            |                 |       |
| 2   |               |            |               |            |                 |       |
| 3   |               |            |               |            |                 |       |
| 4   |               |            |               |            |                 |       |
| 5   |               |            |               |            |                 |       |
| 6   |               |            |               |            |                 |       |
| 7   | *(weekly validation + spot-check)* |  |  |  |  |  |
| 8   |               |            |               |            |                 |       |
| 9   |               |            |               |            |                 |       |
| 10  |               |            |               |            |                 |       |
| 11  |               |            |               |            |                 |       |
| 12  |               |            |               |            |                 |       |
| 13  |               |            |               |            |                 |       |
| 14  | *(weekly validation + spot-check)* |  |  |  |  |  |
| 15  |               |            |               |            |                 |       |
| 16  |               |            |               |            |                 |       |
| 17  |               |            |               |            |                 |       |
| 18  |               |            |               |            |                 |       |
| 19  |               |            |               |            |                 |       |
| 20  |               |            |               |            |                 |       |
| 21  | *(weekly validation + spot-check)* |  |  |  |  |  |
| 22  |               |            |               |            |                 |       |
| 23  |               |            |               |            |                 |       |
| 24  |               |            |               |            |                 |       |
| 25  |               |            |               |            |                 |       |
| 26  |               |            |               |            |                 |       |
| 27  |               |            |               |            |                 |       |
| 28  | *(weekly validation + spot-check)* |  |  |  |  |  |
| 29  |               |            |               |            |                 |       |
| 30  |               |            |               |            |                 |       |

---

## 5. Rollback decision tree

If any daily check goes RED, follow this tree before taking action.

**Step 1: Don't panic.** Legacy tables are still in the database as `_legacy_*`. You can reverse the cutover. The question is whether you need to.

**Step 2: Triage.** Classify the failure:

- **Operational issue (fixable in place):** the new-schema path is correct but something external failed (poller crashed, Redis down, env var flipped). Fix the external issue and re-run the failing check. Do NOT roll back.
- **Data-loss or correctness bug (revert needed):** products are missing, prices are wrong, or the watchdog shows structural drift that does not resolve after the reconciler re-runs. Proceed to Step 3.

**Step 3: Rollback procedure (data-loss path only).**

Get on-call eng sign-off before executing. Document in the Incidents Log.

3a. Stop the worker. No new writes during the rollback window.

3b. Reverse the table renames in a single transaction:

```sql
BEGIN;
ALTER TABLE _legacy_products               RENAME TO products;
ALTER TABLE _legacy_product_versions       RENAME TO product_versions;
ALTER TABLE _legacy_product_identities     RENAME TO product_identities;
ALTER TABLE _legacy_product_variants       RENAME TO product_variants;
ALTER TABLE _legacy_product_variant_versions RENAME TO product_variant_versions;
ALTER TABLE _legacy_proposed_diffs         RENAME TO proposed_diffs;
ALTER TABLE _legacy_proposed_diff_fields   RENAME TO proposed_diff_fields;
COMMIT;
```

3c. Set `CATALOG_USE_NEW_SCHEMA=false` in the environment on all pods/processes.

3d. Restart the worker. Confirm the legacy path is active from the boot logs:

```
[catalog] CATALOG_USE_NEW_SCHEMA=false
```

3e. Run a quick smoke check to confirm legacy reads are working:

```bash
bun --cwd apps/api test src/handlers/catalog.parity.test.ts
```

3f. File a post-mortem. Record: which check fired, day and hour of first failure, the investigation steps taken, and the decision rationale. Phase 8 must be re-planned before the next cutover attempt.

**Step 4: Forward fix (operational path).**

Apply the fix. After the fix is deployed and stable, re-run the failing daily check and confirm it is GREEN before continuing the 30-day clock. Note the incident in the Incidents Log with "Rolled back: no."

---

## 6. Day 30 — Phase 9 entry criteria

The 30-day window passes and Phase 9 (legacy table drop) can be authorized if ALL of the following are true:

1. **30 consecutive days** with no RED alerts on the five daily checks. A RED day that was fixed in place (Step 4 above) resets the count for that metric; eng team decides whether to restart the full 30-day clock or continue.
2. **Four weekly validation runs** at `totalFailed === 0` (weeks 1, 2, 3, 4).
3. **Zero customer-side incident reports** that were attributed to a catalog correctness regression.
4. **Eng team alignment** that the legacy tables can be dropped. This is a human gate — schedule a 15-minute sync before running Phase 9.

Once all four criteria are met, tag the HEAD commit and proceed to Phase 9:

```bash
git tag phase-8-monitor-complete
```

---

## 7. Incidents log

Fill in one entry per incident. Copy the template; do not delete it.

```
## Incident YYYY-MM-DD: <short title>
- Detected via: <check name — e.g. "Check 2: Outbox lag">
- Day of 30-day window: <day number>
- Symptoms:
- Investigation:
- Resolution:
- Rolled back: yes / no
- Days-clock reset: yes / no
```
