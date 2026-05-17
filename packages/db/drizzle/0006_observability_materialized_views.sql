-- Phase 8 — observability materialized views.
-- See packages/observability-views/src/views.ts for source-of-truth SQL.
-- These views are refreshed by the drift-scan cron (hourly).
--
-- NOTE: REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index
-- on each view. We add minimal indexes here; widen as dashboard queries
-- demand.

CREATE MATERIALIZED VIEW IF NOT EXISTS v_fleet_overview AS
    SELECT
      pv.tenant_id,
      pv.canonical_category,
      date_trunc('hour', pv.created_at) AS hour,
      count(*)::int AS version_count,
      avg(NULLIF(pv.confidence_score, 0)::float8) AS avg_confidence,
      count(*) FILTER (WHERE pv.attributes_json IS NOT NULL AND pv.attributes_json != '{}'::jsonb)::int AS with_attrs_count
    FROM product_versions pv
    WHERE pv.created_at > now() - interval '7 days'
    GROUP BY pv.tenant_id, pv.canonical_category, date_trunc('hour', pv.created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_v_fleet_overview
  ON v_fleet_overview (tenant_id, canonical_category, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS v_domain_health AS
    SELECT
      (metadata->>'domain')::text AS domain,
      (metadata->>'parserVersion')::text AS parser_version,
      date_trunc('hour', created_at) AS hour,
      count(*)::int AS fired_count,
      count(*) FILTER (WHERE (metadata->>'success')::boolean = true)::int AS success_count
    FROM audit_events
    WHERE event_type = 'selector.fired'
      AND created_at > now() - interval '7 days'
    GROUP BY (metadata->>'domain'), (metadata->>'parserVersion'), date_trunc('hour', created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_v_domain_health
  ON v_domain_health (domain, parser_version, hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS v_field_completeness AS
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
    GROUP BY pv.tenant_id, pv.canonical_category;
CREATE UNIQUE INDEX IF NOT EXISTS uq_v_field_completeness
  ON v_field_completeness (tenant_id, canonical_category);

CREATE MATERIALIZED VIEW IF NOT EXISTS v_parser_versions AS
    SELECT
      er.extractor_version,
      er.mapper_version,
      er.policy_version_id,
      date_trunc('day', er.created_at) AS day,
      count(*)::int AS run_count
    FROM extraction_runs er
    WHERE er.created_at > now() - interval '14 days'
    GROUP BY er.extractor_version, er.mapper_version, er.policy_version_id, date_trunc('day', er.created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_v_parser_versions
  ON v_parser_versions (extractor_version, mapper_version, policy_version_id, day);

CREATE MATERIALIZED VIEW IF NOT EXISTS v_cost_panel AS
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
    GROUP BY tenant_id, date_trunc('day', created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_v_cost_panel
  ON v_cost_panel (tenant_id, day);
