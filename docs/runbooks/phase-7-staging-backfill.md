# Phase 7 Staging Backfill & Dual-Write Soak Runbook

**When to run.** You have a staging DB (or production-like staging) that still holds legacy product data in `products` / `product_versions`. This runbook backfills those rows into the new catalog schema (`catalog_products`, `catalog_pricing_observations`, etc.) and then runs a 7-day dual-write soak before Phase 8 flag cutover.

**Authorization required.** One eng sign-off that all Phase 1–7 migrations are applied, all Phase 7 tests pass, and the backfill has been reviewed against the known limitations section below. Operational steps (start soak, tag) require a second on-call sign-off.

**Reference:** plan Task 7.6 ("Execute backfill on staging"). Implementation: `apps/worker/scripts/backfill-catalog.ts`, `apps/worker/scripts/validate-backfill.ts`, `apps/worker/scripts/spot-check.ts`. Tests: `apps/worker` (65 tests), `apps/api` catalog.parity (10 tests, 2 documented skips).

---

## Cardinal constraints

- The backfill is **forward-only**. It writes new-schema rows from legacy rows. It does NOT touch legacy tables.
- The backfill is **idempotent** for product and observation rows (upsert). Pricing rows DOUBLE on a `--from-scratch` re-run — see Known Limitations.
- Do NOT set `CATALOG_USE_NEW_SCHEMA=true` until the validation gate passes (`totalFailed === 0`).
- Do NOT tag `phase-7-soak-complete` until 7 consecutive days of monitoring pass all checks.

---

## Prerequisites

Before starting, confirm all of the following:

1. **Staging DB** is a fresh dump of production (or a production-like snapshot) restored locally or into the staging environment. Do not run backfill on a toy dataset — throughput estimates and field coverage are only meaningful on real data.

2. **All Phase 1–7 migrations applied.** Run:
   ```bash
   bun --cwd packages/db run migrate:up
   ```
   Verify with `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 5;`. The highest version must match the latest migration file in `packages/db/migrations/`.

3. **Feature flags are in legacy-only state:**
   - `CATALOG_USE_NEW_SCHEMA=false`
   - `CATALOG_DUAL_WRITE=false`

4. **Worker is stopped.** The dual-write path must not be running during backfill to avoid race conditions on the new tables.

5. **All Phase 7 tests pass locally.** Run the full test sweep before touching staging:
   ```bash
   cd packages/catalog/event-outbox && bun test   # expect 41
   cd packages/db && bun test                      # expect 108
   cd apps/worker && bun test                      # expect 65
   cd apps/api && bun test                         # expect 34 pass, 2 skip
   cd packages/catalog/catalog-service && bun test src  # expect 84
   cd packages/catalog/watchdog && bun test        # expect 21
   cd packages/catalog/source-adapters && bun test src  # expect 20
   ```
   If any package fails, do NOT proceed to staging.

---

## Step 1: Pre-flight checks

### 1.1 Confirm legacy table counts

```sql
SELECT COUNT(*) AS products        FROM products         WHERE tenant_id = '<tenant_id>';
SELECT COUNT(*) AS product_versions FROM product_versions WHERE tenant_id = '<tenant_id>';
```

Note these counts. After the backfill they will be your expected `processed` total.

### 1.2 Confirm new tables are empty for the target tenant

```sql
SELECT COUNT(*) AS catalog_products FROM catalog_products WHERE tenant_id = '<tenant_id>';
SELECT COUNT(*) AS pricing_obs      FROM catalog_pricing_observations
                                    JOIN catalog_products USING (product_id)
                                    WHERE catalog_products.tenant_id = '<tenant_id>';
```

Both should return 0. If not, investigate before running backfill. A non-zero count means a prior partial backfill ran; in that case the idempotent upsert path is still safe for products and observations — but see the pricing-rows-doubling limitation below before deciding to re-run.

### 1.3 Identify the tenant

```sql
SELECT id AS tenant_id, name
FROM tenants
WHERE name = '<your-tenant-name>';
```

Record `tenant_id` — you will pass it to every script below as `--tenant-id <uuid>`.

### 1.4 Confirm backfill cursor table is empty

```sql
SELECT * FROM backfill_cursor WHERE tenant_id = '<tenant_id>';
```

Empty means no prior run. If a cursor row exists it carries `last_product_version_id` and `total_processed` — the backfill will resume from that point automatically.

---

## Step 2: Backfill execution

### 2.1 Dry-run first (optional but recommended for paranoia)

```bash
bun --cwd apps/worker run scripts/backfill-catalog.ts \
  --tenant-id <uuid> \
  --batch-size 100 \
  --dry-run
```

Inspect the console output. Each line shows what WOULD be written:
```
[backfill-catalog]   [DRY-RUN] would write product_version <id>: N obs, M pricing, identityHint={...}
```

No DB writes occur. Confirm field shapes look correct before proceeding to the live run.

### 2.2 Live run

```bash
bun --cwd apps/worker run scripts/backfill-catalog.ts \
  --tenant-id <uuid> \
  --batch-size 100
```

Expected throughput: **~1000 products/min**. If sustained throughput drops below 500/min for more than 5 minutes, investigate DB I/O or batch-size tuning.

Console output per row:
```
[backfill-catalog]   product_version <id>: productId=<uuid> created=true obs=N pricing=M
```

Final summary line:
```
[backfill-catalog] Summary: tenant=<uuid> processed=N skipped=0 failed=0 completed=true dryRun=false
```

- `completed=true` means the cursor was marked done.
- `failed > 0` means some product versions could not be backfilled. Check logs for the specific `product_version` IDs and investigate before running validation.

### 2.3 Monitor the cursor mid-run (separate shell)

```sql
SELECT tenant_id, last_product_version_id, total_processed, total_skipped, total_failed, completed_at
FROM backfill_cursor
WHERE tenant_id = '<tenant_id>';
```

Poll this every minute. `total_processed` should increase monotonically. `completed_at IS NOT NULL` means the run finished.

### 2.4 On failure: resume

The backfill is resumable. If the process crashes or is killed, simply re-run the same command — the cursor picks up from `last_product_version_id`. The upsert path ensures already-written products and observations are not duplicated (pricing rows are an exception — see Known Limitations).

---

## Step 3: Validation

```bash
bun --cwd apps/worker run scripts/validate-backfill.ts \
  --tenant-id <uuid> \
  --output backfill-report.json \
  --strict
```

This scans every `catalog_products` row for the tenant and checks required fields against the corresponding legacy row.

### Gate condition

```
totalFailed === 0
```

on required fields: `title`, `brand`, `gtin`, `primary_pricing`.

Console success indicator:
```
[validate-backfill] Zero required-field losses. images comparison skipped, see Task 7.1 limitations.
```

Console failure indicator:
```
[validate-backfill] WARN: Required-field losses detected. failuresByField={"title":3}
```

If failures are reported:
1. Open `backfill-report.json` and read the `sampleFailures` array for the affected field.
2. Identify the root cause (missing legacy value, mapping bug, or cursor gap).
3. Fix the root cause in the backfill script or the source data.
4. Re-run the backfill (Step 2), then re-run validation (this step).

**DO NOT PROCEED to the soak (Step 5) if validation fails.**

---

## Step 4: Spot-check

```bash
bun --cwd apps/worker run scripts/spot-check.ts \
  --tenant-id <uuid> \
  --sample-size 100 \
  --output spot-check.html
```

Open `spot-check.html` in a browser. Review the **"Possible losses"** section. This section highlights fields where the new-schema row has a null or lower-confidence value than the legacy row, even if those fields are not in the validation gate (e.g. optional enrichment fields, soft-required dimensions).

Triage each entry with the eng team. Entries that represent acceptable data-shape differences (e.g. images — deferred per Task 7.1) should be documented. Entries that represent unexpected data loss should be investigated and fixed before the soak.

The spot-check is advisory, not a hard gate. Use engineering judgment.

---

## Step 5: Start dual-write soak

Once Steps 3 and 4 are satisfactory:

### 5.1 Set environment variables

```bash
export CATALOG_USE_NEW_SCHEMA=true
export CATALOG_DUAL_WRITE=true
```

Or update your deployment manifest / environment configuration so the worker boots with both flags.

### 5.2 Start the worker

```bash
bun --cwd apps/worker run start
```

### 5.3 Confirm flags in boot logs

Within the first 10 lines of worker output you should see both flags acknowledged:
```
[catalog] CATALOG_USE_NEW_SCHEMA=true
[catalog] CATALOG_DUAL_WRITE=true
```

If either flag is missing or shows `false`, the worker is reading stale env. Fix the environment and restart.

---

## Step 6: Daily monitoring (7 days)

Run all three checks each day, every day, for 7 consecutive days. All must pass before tagging.

### 6.1 Re-run validation

```bash
bun --cwd apps/worker run scripts/validate-backfill.ts \
  --tenant-id <uuid> \
  --output "backfill-report-day$(date +%d).json" \
  --strict
```

Required: `totalFailed === 0` on required fields. Any regression in a previously-passing field means the dual-write path has a bug. **Stop the soak and investigate immediately.**

### 6.2 Re-run spot-check

```bash
bun --cwd apps/worker run scripts/spot-check.ts \
  --tenant-id <uuid> \
  --sample-size 100 \
  --output "spot-check-day$(date +%d).html"
```

Compare the "Possible losses" section against the baseline from Step 4. The set of losses should be stable or shrinking. A new field appearing in losses after the soak started indicates a dual-write regression.

### 6.3 Re-run parity tests

```bash
bun --cwd apps/api test src/handlers/catalog.parity.test.ts
```

Expected: 7 pass, 2 skip, 0 fail. Any new failure is a parity break — stop the soak and file an issue.

### 6.4 Watchdog drift rate

Connect to the staging DB and check:

```sql
SELECT
  DATE_TRUNC('hour', checked_at) AS hour,
  COUNT(*) FILTER (WHERE is_drift)       AS drift_count,
  COUNT(*)                                AS total_count,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE is_drift) / NULLIF(COUNT(*), 0),
    3
  ) AS drift_rate_pct
FROM catalog_watchdog_log
WHERE tenant_id = '<tenant_id>'
  AND checked_at > NOW() - INTERVAL '1 day'
GROUP BY 1
ORDER BY 1 DESC;
```

Required: `drift_rate_pct < 0.1` for every hour in the last 24 hours. If any hour shows >= 0.1%, investigate that hour's drift log:

```sql
SELECT product_id, attr, channel, locale, stored_value, expected_value, checked_at
FROM catalog_watchdog_log
WHERE tenant_id = '<tenant_id>'
  AND is_drift = true
  AND checked_at BETWEEN '<hour_start>' AND '<hour_end>'
ORDER BY checked_at;
```

### 6.5 Customer-visible API smoke

Manually or via a scripted smoke runner, exercise:

```
GET /products/<known_product_id>
GET /products/<known_product_id>/sku
GET /products/<known_product_id>/provenance
```

Use a product that has both legacy and new-schema rows. Compare the response bodies across the 7 days. Any field that was present on Day 1 and disappears on a later day is a regression. File an issue with the full diff.

### 6.6 Daily pass log

Keep a simple day-by-day log (in your incident tracker or a shared doc):

| Day | Validation | Spot-check | Parity tests | Watchdog drift | API smoke | Notes |
|-----|-----------|------------|--------------|----------------|-----------|-------|
| 1   | PASS      | PASS       | 7/7 + 2skip  | < 0.1%         | OK        |       |
| …   |           |            |              |                |           |       |
| 7   |           |            |              |                |           |       |

All 7 rows must show PASS before proceeding to Step 7.

---

## Step 7: Tag completion

Once all 7 days of daily checks pass:

```bash
git tag phase-7-soak-complete
```

Push the tag if your team's process requires it (operator decision — coordinate with the team before pushing to shared remotes):

```bash
git push origin phase-7-soak-complete
```

This tag marks the HEAD at which the Phase 7 soak passed and Phase 8 flag cutover planning can begin.

---

## Rollback (soak failure)

If any daily check fails during the soak and the root cause cannot be fixed quickly:

1. **Stop the worker.**
2. Set `CATALOG_USE_NEW_SCHEMA=false` and `CATALOG_DUAL_WRITE=false` in the environment.
3. **Restart the worker.** Confirm the legacy-only path is serving traffic from the boot logs.
4. **Do NOT delete the new-schema rows.** The backfill is forward-only. The new-schema rows remain in place; the reconciler / watchdog will catch any drift when the soak resumes.
5. File a Phase 7 issue with:
   - Which daily check failed.
   - The day and hour of first failure.
   - Relevant log excerpts (validation report, spot-check diff, watchdog query output).
   - Steps taken before rollback.
6. Fix the root cause, confirm all Phase 7 tests still pass, and restart the soak from Step 5 (the backfill does not need to re-run unless new products were ingested since the original run — in that case run the backfill again, then validate, then restart the soak).

---

## Known limitations from Phase 7

The following are documented limitations accepted before Phase 8; they are NOT blockers for this runbook.

| Limitation | Detail | Task ref |
|------------|--------|----------|
| **Images deferred** | `catalog_products.images` column is not backfilled. Validation skips image comparison. | Task 7.1 |
| **Variants deferred** | Variant relationship rows are not backfilled. Spot-check "Possible losses" will flag variant-linked products. | Task 7.1 |
| **Inventory observations deferred** | `catalog_inventory_observations` are not backfilled from legacy inventory tables. | Task 7.1 |
| **Pricing rows double on `--from-scratch` re-run** | Pricing observation rows do not upsert — they insert. A second full backfill run will create duplicate pricing rows. Resuming from cursor avoids this; only a forced `--from-scratch` re-run doubles them. | Task 7.1 |
| **List endpoint flag-invariant** | `GET /products` (list) is NOT switched by `CATALOG_USE_NEW_SCHEMA`. It always reads the legacy table. Phase 8 cutover work addresses this. The parity test documents this as a known skip. | Task 7.5 parity gap |
| **`tenant_webhooks.secret` HMAC signing** | Webhook signing is reserved for v2. Not covered by dual-write soak. | Phase 7 deferred |

---

## Record-keeping

Append an entry to your team's deployment log once the soak completes:

- Date range of soak (start → tag date).
- Tenant ID(s) backfilled.
- Backfill summary: `processed`, `failed`, `skipped` from the final `validate-backfill` report.
- Git tag: `phase-7-soak-complete` → commit SHA.
- Link to daily monitoring log.
- Engineer who executed the runbook + on-call sign-off.
