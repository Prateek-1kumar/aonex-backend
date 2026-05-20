# @aonex/observability-views

SQL definitions for the five Postgres materialized views that back Grafana dashboards — fleet ingestion volume, domain health, field completeness, parser versions, and LLM cost.

## Exports

- `VIEW_DEFINITIONS` — `Record<ObservabilityViewName, string>`: raw SQL SELECT for each view
- `REFRESH_ALL_VIEWS_SQL` — string of `REFRESH MATERIALIZED VIEW CONCURRENTLY` statements for all five views
- `ObservabilityViewName` — union: `"v_fleet_overview" | "v_domain_health" | "v_field_completeness" | "v_parser_versions" | "v_cost_panel"`

Views read from `product_versions`, `audit_events`, and `extraction_runs` with 7–30 day rolling windows.

## How it fits

The migration at `packages/db/drizzle/0006_observability_materialized_views.sql` creates the views. The drift-scan cron in `apps/worker` calls `REFRESH_ALL_VIEWS_SQL` hourly to keep dashboards current without per-render query cost.

## Dependencies

None (`@aonex/*`-free; pure SQL strings).
