-- Catalog redesign Phase 5, Task 5.7 — tenant_webhooks (webhook consumer v1).
--
-- Per-tenant webhook subscriptions for catalog events. v1 shape is intentionally
-- small: one row per (tenant, URL) carrying an event_types[] filter that the
-- webhook consumer matches against the inbound stream entry's `eventType`.
--
-- The `secret` column is reserved for HMAC signing (v2); v1 emits no signature.
-- The DLQ for failed deliveries is deferred — v1 surfaces failures via a stats
-- counter on the consumer handle and a warn log. See plan §5.7 and spec §19.
--
-- No FK on tenant_id by design: the webhook table is operator-owned and a
-- tenant tombstone shouldn't cascade-delete the routing config. We may add
-- an FK in a later migration once the tenant lifecycle is finalized.

CREATE TABLE tenant_webhooks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  url           TEXT NOT NULL,
  event_types   TEXT[] NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  secret        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup index: backs the consumer's per-event tenant routing query
--   SELECT url, event_types FROM tenant_webhooks
--   WHERE tenant_id = $1 AND active = true AND $2 = ANY(event_types)
-- Partial-on-active so inactive rows don't bloat the index.
CREATE INDEX idx_tenant_webhooks_tenant
  ON tenant_webhooks (tenant_id) WHERE active;
