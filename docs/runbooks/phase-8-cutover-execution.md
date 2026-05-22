# Phase 8 Cutover Execution Runbook

**Tasks:** 8.3 (staging cutover dry run) and 8.4 (production cutover).
**Who runs this.** On-call eng with RDS snapshot access and env-var deployment permissions.
**Code artifact.** `apps/worker/scripts/cutover.ts` — read the inline `--help` before running.
**After cutover.** Follow `docs/runbooks/catalog-redesign-30day-monitor.md` for the 30-day soak window.

---

## Task 8.3 — Staging Cutover Dry Run

### Pre-requisites

1. Phase 7 staging soak has passed — see `docs/runbooks/phase-7-staging-backfill.md`.
   - All weekly validation runs returned `totalFailed === 0`.
   - Spot-check showed stable or shrinking "Possible losses" for 7 consecutive days.
2. `CATALOG_USE_NEW_SCHEMA=true` is already set on the staging worker (it must be; it was required for Phase 7 to run).
3. Staging database is accessible and `DATABASE_URL` resolves to the staging RDS instance.

### Steps

**Step 1. Disable dual-write and drain BullMQ.**

Set the staging worker environment variable:

```
CATALOG_DUAL_WRITE=false
```

Restart the staging worker process (or pod). Wait until BullMQ queues are empty — no pending `link-extract` or `drain` jobs. Check via your Redis CLI or BullMQ dashboard:

```bash
# Rough check — all these should return 0.
redis-cli -u "$REDIS_URL" LLEN bull:link-extract:wait
redis-cli -u "$REDIS_URL" LLEN bull:link-extract:active
redis-cli -u "$REDIS_URL" LLEN bull:drain:wait
redis-cli -u "$REDIS_URL" LLEN bull:drain:active
```

**Step 2. Take a staging RDS snapshot.**

Name it something like `catalog-redesign-phase8-staging-pre-cutover-<YYYY-MM-DD>`. This is your rollback insurance for staging. Wait until the snapshot status is `available` before proceeding.

**Step 3. Run the cutover script.**

```bash
bun --env-file=../../.env --cwd apps/worker run scripts/cutover.ts \
  --tenant-id <staging-tenant-uuid> \
  --confirm-drained \
  --save-report cutover-staging.json
```

Expected terminal output (success path):

```
[cutover] Starting cutover for tenant=<uuid> dryRun=false
[cutover] Pre-flight passed: backfill cursor complete at <timestamp>
[cutover] Running final validation check (strict mode)...
[cutover] Validation passed: N/N products passed.
[cutover] Renaming 7 legacy table(s) in a single transaction...
[cutover]   Renamed: products → _legacy_products
[cutover]   Renamed: product_versions → _legacy_product_versions
[cutover]   Renamed: product_identities → _legacy_product_identities
[cutover]   Renamed: product_variants → _legacy_product_variants
[cutover]   Renamed: product_variant_versions → _legacy_product_variant_versions
[cutover]   Renamed: proposed_diffs → _legacy_proposed_diffs
[cutover]   Renamed: proposed_diff_fields → _legacy_proposed_diff_fields
[cutover] Successfully renamed 7 table(s).
[cutover] Running post-rename smoke checks...
[cutover] Smoke: SELECT 1 FROM _legacy_products — OK
[cutover] Smoke: catalog_products readable for tenant=<uuid>, found N row(s) — OK
[cutover] Cutover complete for tenant=<uuid>: renamed=7 already=0
```

Exit code 0 = success. Exit code 1 = pre-flight failure (inspect output, fix, re-run). Exit code 2 = runtime error during rename (the Postgres transaction rolled back — no partial state; inspect logs and DB before re-running).

**Step 4. Verify staging for 1 hour.**

- Hit API endpoints manually: `GET /products/:id`, `GET /products/:id/provenance/:attribute_code`.
- Watch worker logs for any errors.
- Run the parity test suite against the staging API:
  ```bash
  bun --cwd apps/api test src/handlers/catalog.parity.test.ts
  ```
  Expected: 7 pass, 2 skip, 0 fail.
- Confirm no 5xx errors in staging API logs.

All four checks must be GREEN before proceeding.

**Step 5. Tag the staging cutover commit.**

```bash
git tag phase-8-staging-cutover
```

Save `cutover-staging.json` (written to the working directory unless an absolute path was given) to your incident/release artifacts store.

---

## Task 8.4 — Production Cutover

### Pre-requisites

1. Staging cutover (Task 8.3) completed successfully AND held stable for at least **3 days** with no regressions.
2. `CATALOG_USE_NEW_SCHEMA=true` is already set on the production worker (required since Phase 7).
3. Team and customer maintenance window announced. Suggested window: off-peak hours (low traffic, no active campaigns). Announce at least 24 hours in advance to the engineering team; if customer-facing downtime is expected, announce at least 72 hours in advance.
4. On-call engineer available for the entire window (minimum 90 minutes).

### Steps

**Step 1. Announce the maintenance window.**

Send the announcement to your engineering Slack channel (or equivalent). Include:
- Start time and expected duration (allow 60–90 minutes end-to-end).
- Tenant(s) in scope.
- Rollback contact (the on-call engineer running the script).

**Step 2. Drain production BullMQ.**

Set the production worker environment:

```
CATALOG_DUAL_WRITE=false
```

Restart the production worker. Wait until all BullMQ queues are empty. Use the same Redis checks as Step 1 of Task 8.3 but pointed at the production Redis URL.

**Step 3. Take a production RDS snapshot.**

Name it `catalog-redesign-phase8-prod-pre-cutover-<YYYY-MM-DD>`. Wait until status is `available`. This is your rollback insurance — do not skip it.

**Step 4. Run the cutover script.**

```bash
bun --env-file=../../.env --cwd apps/worker run scripts/cutover.ts \
  --tenant-id <production-tenant-uuid> \
  --confirm-drained \
  --save-report cutover-prod-<YYYY-MM-DD>.json
```

If you have multiple tenants, run the script once per tenant. Wait for each run to exit 0 before starting the next.

Exit code 0 = success. Any other exit code: stop, diagnose from the log output, and consult the rollback procedure in `docs/runbooks/catalog-redesign-30day-monitor.md` Section 5 if data-loss is suspected.

**Step 5. Smoke check (first 10 minutes).**

Immediately after the script exits 0:

1. Hit random products via the API for 10 minutes. Sample at least 10 different `product_id` values spanning different merchants:
   ```bash
   curl -s "https://<api-host>/products/<product_id>" | jq '.id, .title'
   ```
2. Check error rate on the API (5xx responses). Must be `< 0.1%`.
3. Check worker logs — no panics, no `CATALOG_USE_NEW_SCHEMA=false` boot messages.
4. Confirm `catalog_products` is readable for each tenant:
   ```sql
   SELECT COUNT(*) FROM catalog_products WHERE tenant_id = '<uuid>';
   ```

If any smoke check fails: HALT. Do not proceed with more tenants. Follow the rollback decision tree in `docs/runbooks/catalog-redesign-30day-monitor.md` Section 5.

**Step 6. Begin 30-day monitoring.**

Open `docs/runbooks/catalog-redesign-30day-monitor.md` and fill in Day 1 of the daily pass log. Run all five daily checks before end of day.

**Step 7. Tag the production cutover commit.**

```bash
# Single tenant:
git tag phase-8-production-cutover

# Multiple tenants — use a suffix per tenant so tags are distinct:
git tag phase-8-production-cutover-<tenant-short-name>
```

Save each `cutover-prod-<date>.json` to your incident/release artifacts store alongside the pre-cutover RDS snapshot name.

---

## Exit criteria for Phase 8

Phase 8 is complete and Phase 9 (legacy table drop) can be authorized when all of the following are true:

- All production tenants have exit code 0 from the cutover script.
- 30-day monitoring window has passed per `docs/runbooks/catalog-redesign-30day-monitor.md` Section 6.
- No customer-side incident reports attributed to a catalog correctness regression.
- Engineering team has held the Phase 9 authorization sync.

The `phase-8-staging-cutover` and `phase-8-production-cutover` tags are created by the operator at run time, not by this automation.

---

## Quick-reference: rollback SQL

If a rollback is needed during the 30-day window, stop the worker, then run the following in a single transaction. Full decision tree is in `docs/runbooks/catalog-redesign-30day-monitor.md` Section 5.

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

Then set `CATALOG_USE_NEW_SCHEMA=false` on all pods, restart the worker, and file a post-mortem.
