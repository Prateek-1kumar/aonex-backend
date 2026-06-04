// Public surface of `@aonex/observability-views`.
//
// Re-exports the SQL SELECTs for the Postgres materialized views backing the
// Grafana observability dashboards (VIEW_DEFINITIONS), the REFRESH_ALL_VIEWS_SQL
// run from the drift-scan cron, and the ObservabilityViewName union. Spec §12.4.

export {
  VIEW_DEFINITIONS,
  REFRESH_ALL_VIEWS_SQL,
  type ObservabilityViewName
} from "./views.js";
