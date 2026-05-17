/**
 * Spec §12.4 — observability materialized views.
 *
 * These views give us per-tenant + per-domain cardinality for Grafana
 * dashboards without burning Postgres on every render. Refresh hourly
 * via the drift-scan cron (Phase 8).
 *
 * Each view's SELECT lives here as a string. The migration at
 * packages/db/drizzle/0006_observability_materialized_views.sql wraps
 * each in `CREATE MATERIALIZED VIEW IF NOT EXISTS <name> AS <select>`.
 */

export type ObservabilityViewName =
  | "v_fleet_overview"
  | "v_domain_health"
  | "v_field_completeness"
  | "v_parser_versions"
  | "v_cost_panel";

/**
 * Per-view SQL SELECTs. The migration wraps each in
 * `CREATE MATERIALIZED VIEW IF NOT EXISTS v_<name> AS (...)`.
 */
export const VIEW_DEFINITIONS: Record<ObservabilityViewName, string> = {
  // 1) FLEET OVERVIEW — recent ingestion volume + average confidence per lane × category
  v_fleet_overview: `
    SELECT
      pv.tenant_id,
      pv.canonical_category,
      date_trunc('hour', pv.created_at) AS hour,
      count(*)::int AS version_count,
      avg(NULLIF(pv.confidence_score, 0)::float8) AS avg_confidence,
      count(*) FILTER (WHERE pv.attributes_json IS NOT NULL AND pv.attributes_json != '{}'::jsonb)::int AS with_attrs_count
    FROM product_versions pv
    WHERE pv.created_at > now() - interval '7 days'
    GROUP BY pv.tenant_id, pv.canonical_category, date_trunc('hour', pv.created_at)
  `,

  // 2) DOMAIN HEALTH — per-(domain × parser) selector firing success rate from audit_events
  v_domain_health: `
    SELECT
      (metadata->>'domain')::text AS domain,
      (metadata->>'parserVersion')::text AS parser_version,
      date_trunc('hour', created_at) AS hour,
      count(*)::int AS fired_count,
      count(*) FILTER (WHERE (metadata->>'success')::boolean = true)::int AS success_count
    FROM audit_events
    WHERE event_type = 'selector.fired'
      AND created_at > now() - interval '7 days'
    GROUP BY (metadata->>'domain'), (metadata->>'parserVersion'), date_trunc('hour', created_at)
  `,

  // 3) FIELD COMPLETENESS — % of recent product_versions with each canonical field populated
  v_field_completeness: `
    SELECT
      pv.tenant_id,
      pv.canonical_category,
      count(*)::int AS total,
      count(pv.title) FILTER (WHERE pv.title <> '')::int AS title_count,
      count(pv.brand) FILTER (WHERE pv.brand <> '')::int AS brand_count,
      count(pv.gtin) FILTER (WHERE pv.gtin <> '')::int AS gtin_count,
      count(pv.base_price) FILTER (WHERE pv.base_price IS NOT NULL)::int AS base_price_count,
      count(*) FILTER (WHERE pv.attributes_json IS NOT NULL AND pv.attributes_json != '{}'::jsonb)::int AS attributes_count
    FROM product_versions pv
    WHERE pv.created_at > now() - interval '24 hours'
    GROUP BY pv.tenant_id, pv.canonical_category
  `,

  // 4) PARSER VERSIONS — distribution of extractor_version + mapper_version in recent ingestions
  v_parser_versions: `
    SELECT
      er.extractor_version,
      er.mapper_version,
      er.policy_version_id,
      date_trunc('day', er.created_at) AS day,
      count(*)::int AS run_count
    FROM extraction_runs er
    WHERE er.created_at > now() - interval '14 days'
    GROUP BY er.extractor_version, er.mapper_version, er.policy_version_id, date_trunc('day', er.created_at)
  `,

  // 5) COST PANEL — per-tenant LLM cost in USD from audit metadata
  v_cost_panel: `
    SELECT
      tenant_id,
      date_trunc('day', created_at) AS day,
      sum(COALESCE((metadata->>'estimatedCostUsd')::float8, 0))::float8 AS total_cost_usd,
      sum(COALESCE((metadata->>'promptTokens')::int, 0))::bigint AS total_prompt_tokens,
      sum(COALESCE((metadata->>'completionTokens')::int, 0))::bigint AS total_completion_tokens,
      count(*)::int AS llm_call_count
    FROM audit_events
    WHERE event_type LIKE 'llm.%'
      AND created_at > now() - interval '30 days'
    GROUP BY tenant_id, date_trunc('day', created_at)
  `
};

/**
 * SQL to refresh all materialized views. Run from a cron (drift-scan)
 * to keep dashboards fresh without per-render compute cost.
 */
export const REFRESH_ALL_VIEWS_SQL = (Object.keys(VIEW_DEFINITIONS) as ObservabilityViewName[])
  .map((view) => `REFRESH MATERIALIZED VIEW CONCURRENTLY ${view};`)
  .join("\n");
