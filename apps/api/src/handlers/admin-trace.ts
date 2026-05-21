// Admin trace handler — Task 4.5, spec §20.
//
// Endpoint:
//   GET /products/:product_id/provenance/:attribute_code
//     ?channel=<channelCode>&locale=<locale>
//
// Returns the FULL chain that produced the currently-winning value for
// one (product, attribute, channel, locale) leaf:
//   winner → source_priority rule that picked it → underlying observation
//   → source artifact id → (Phase 5+) raw payload pointer.
//
// Wiring contract: the route is mounted ONLY when
// `useNewCatalogSchema=true` on the catalog routes deps. Under the
// legacy flag-OFF surface there's no `winning_values` or rule-driven
// projection to trace, so the endpoint returns 404 (same as
// "route not found" — Hono falls through to its default 404 handler).
//
// Auth / safety:
//   - tenantId + merchantId come from the JWT-stamped context vars
//     (same convention as `getProductById`).
//   - Cross-tenant 404: row exists but belongs to a different tenant →
//     404, never 403 or empty 200.
//   - Cross-merchant 404: row exists in the same tenant but belongs to
//     a different merchant → 404. Mirrors Task 4.4 (`getProductById`).
//   - Non-UUID `product_id` → 400, not 404, so callers get a clear
//     "bad input" signal vs. "valid id but no such row".

import type { Context } from "hono";
import { MerchantId, TenantId } from "@aonex/types";
import type { CatalogRouteDeps } from "../routes/catalog.js";
import {
  readProvenance,
  PRODUCT_NOT_FOUND,
} from "../services/new-catalog-provenance.js";
import {
  readProductTrace,
  PRODUCT_NOT_FOUND as TRACE_PRODUCT_NOT_FOUND,
  type ProductTraceResult,
  type TraceCursor,
} from "../services/new-catalog-trace.js";

/** Tight UUID v1-v5 regex. Permissive enough for any well-formed id. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Lenient UUID detector that also accepts the all-zero / all-`f` test
 * UUIDs used in seeds — those are valid v0/synthetic ids that our test
 * infrastructure relies on. A strict v1-v5 check would reject them.
 */
function looksLikeUuid(s: string): boolean {
  if (UUID_RE.test(s)) return true;
  // 8-4-4-4-12 structure, hex only — permissive fallback for synthetic test UUIDs.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * GET /products/:product_id/provenance/:attribute_code — trace the
 * winning value for one (product, attribute, channel, locale) leaf
 * back to the rule, observation, and source artifact that produced it.
 *
 * Query params:
 *   - `channel` (default `"_unscoped"`): channel CODE
 *     (e.g. `"shopify-au"`). For sync attributes (title, brand, ...)
 *     this is the outer key in `catalog_products.values[attr]`. For
 *     pricing/inventory this is translated to a channel UUID via
 *     `(tenantId, channelKind)` for the side-table query.
 *   - `locale` (default `"_unscoped"`): locale code (e.g. `"en_AU"`).
 *     Pricing uses this on `catalog_pricing_observations.locale`.
 *     Inventory has no locale dimension and ignores this param.
 *
 * Responses:
 *   - 200 with the trace, OR with all-null fields when the product
 *     exists but the leaf has no observations (distinguishes "no data"
 *     from "no product" — frontends can render "no winner" without
 *     coding around a 404).
 *   - 400 when `product_id` isn't a UUID.
 *   - 404 when the product doesn't exist OR belongs to a different
 *     tenant/merchant.
 */
export async function getProductProvenanceTrace(
  c: Context,
  deps: CatalogRouteDeps
): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const merchantId = MerchantId.unsafeFrom(
    c.get("merchantId" as never) as string
  );

  const productId = c.req.param("product_id") as string;
  const attributeCode = c.req.param("attribute_code") as string;

  if (!productId || !looksLikeUuid(productId)) {
    return c.json(
      {
        error: {
          code: "INVALID_PRODUCT_ID",
          message: "product_id must be a UUID",
        },
      },
      400
    );
  }
  if (!attributeCode || attributeCode.length === 0) {
    return c.json(
      {
        error: {
          code: "INVALID_ATTRIBUTE_CODE",
          message: "attribute_code is required",
        },
      },
      400
    );
  }

  // Defaults: `_unscoped` matches the writer convention for
  // channel/locale-agnostic attributes (brand, description, ...).
  const channel = c.req.query("channel") ?? "_unscoped";
  const locale = c.req.query("locale") ?? "_unscoped";

  const result = await readProvenance(deps.db, {
    tenantId,
    merchantId,
    productId,
    attributeCode,
    channel,
    locale,
  });

  if (result === PRODUCT_NOT_FOUND) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Product not found" } },
      404
    );
  }

  return c.json({ data: result });
}

/**
 * Parse an ISO-8601 timestamp from a query param. Returns:
 *   - `undefined` when the param is absent (caller picks a default).
 *   - `Date` instance when valid.
 *   - `INVALID` symbol when present but unparseable (caller returns 400).
 */
const INVALID_ISO = Symbol("invalid-iso");
type ParsedIso = Date | undefined | typeof INVALID_ISO;

function parseIsoQuery(raw: string | undefined): ParsedIso {
  if (raw === undefined || raw === "") return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return INVALID_ISO;
  return d;
}

/**
 * Parse a positive-integer query param. Returns:
 *   - `undefined` when absent (caller picks a default).
 *   - parsed number when finite & positive.
 *   - `INVALID` symbol when malformed (caller returns 400).
 */
const INVALID_INT = Symbol("invalid-int");
type ParsedInt = number | undefined | typeof INVALID_INT;

function parsePositiveIntQuery(raw: string | undefined): ParsedInt {
  if (raw === undefined || raw === "") return undefined;
  // Reject non-numeric strings outright — `parseInt("3abc")` would silently
  // accept `3`, but for a debug endpoint we'd rather fail loud on typos.
  if (!/^[0-9]+$/.test(raw)) return INVALID_INT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return INVALID_INT;
  return n;
}

/**
 * Parse a composite pagination cursor `<iso>|<id>`. Returns:
 *   - `undefined` when absent (caller picks a default — no cursor).
 *   - `{ ts: Date, id: number }` when valid.
 *   - `INVALID` symbol when malformed (caller returns 400). Legacy
 *     single-timestamp cursors (no `|`) are rejected explicitly — we are
 *     pre-release, so hard-breaking gives clients a clear error message
 *     rather than half-pages or silently-skipped rows.
 */
const INVALID_CURSOR = Symbol("invalid-cursor");
type ParsedCursor = TraceCursor | undefined | typeof INVALID_CURSOR;

function parseCursorQuery(raw: string | undefined): ParsedCursor {
  if (raw === undefined || raw === "") return undefined;
  const sep = raw.indexOf("|");
  if (sep < 0) return INVALID_CURSOR;
  const tsPart = raw.slice(0, sep);
  const idPart = raw.slice(sep + 1);
  if (!tsPart || !idPart) return INVALID_CURSOR;
  const ts = new Date(tsPart);
  if (Number.isNaN(ts.getTime())) return INVALID_CURSOR;
  if (!/^[0-9]+$/.test(idPart)) return INVALID_CURSOR;
  const id = Number(idPart);
  if (!Number.isFinite(id) || id < 0) return INVALID_CURSOR;
  return { ts, id };
}

/**
 * GET /products/:product_id/trace — unified product debug payload.
 *
 * Returns a single JSON document covering:
 *   - Current `catalog_products` row (identity, status, winning_values).
 *   - Pricing & inventory observations (last N within the window).
 *   - Revisions (last N).
 *   - Active reconciliation_overrides.
 *   - Recent catalog_events (outbox).
 *   - `observationsByAttribute` (passthrough of `catalog_products.values`).
 *
 * This is a HEAVY READ — up to 6 SELECTs run in parallel via the service
 * helper. Intended as an admin / support / debugging surface, not a hot
 * path. Production deployments should consider rate-limiting if exposed.
 *
 * Query params:
 *   - `since=<iso>` overrides the 30-day default window.
 *   - `observations_limit` / `revisions_limit` / `events_limit` cap each
 *     section; clamped server-side ([1, 5000] / [1, 200] / [1, 200]).
 *   - `observations_cursor` / `revisions_cursor` / `events_cursor` are
 *     composite pagination cursors in the form `<iso>|<id>` (e.g.
 *     `2026-05-22T10:30:00.000Z|7392`). The id is the bigint primary key
 *     of the last row on the previous page; it ties-breaks rows with
 *     equal timestamps so we never silently drop / duplicate rows. Pass
 *     back the `pagination.*_next_cursor` values to fetch the next page.
 *     LEGACY single-timestamp cursors (no `|`) are REJECTED — this is a
 *     pre-release surface; we'd rather fail loud than half-page.
 *
 * Responses:
 *   - 200 with `{ data: ProductTraceResult }` (see service-layer types).
 *   - 400 with `INVALID_PRODUCT_ID` when `product_id` isn't a UUID.
 *   - 400 with `INVALID_QUERY` when an `iso` or `int` query param is
 *     malformed — fail-loud beats silent fallback for a debug surface.
 *   - 404 when the product doesn't exist OR belongs to a different
 *     tenant/merchant (no existence leak across tenants).
 */
export async function getProductTrace(
  c: Context,
  deps: CatalogRouteDeps
): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const merchantId = MerchantId.unsafeFrom(
    c.get("merchantId" as never) as string
  );

  const productId = c.req.param("product_id") as string;
  if (!productId || !looksLikeUuid(productId)) {
    return c.json(
      {
        error: {
          code: "INVALID_PRODUCT_ID",
          message: "product_id must be a UUID",
        },
      },
      400
    );
  }

  // Parse + validate query params. Each malformed value becomes a 400.
  const sinceParsed = parseIsoQuery(c.req.query("since"));
  if (sinceParsed === INVALID_ISO) {
    return c.json(
      { error: { code: "INVALID_QUERY", message: "since must be an ISO-8601 timestamp" } },
      400
    );
  }
  const observationsCursorParsed = parseCursorQuery(
    c.req.query("observations_cursor")
  );
  if (observationsCursorParsed === INVALID_CURSOR) {
    return c.json(
      {
        error: {
          code: "INVALID_QUERY",
          message:
            "observations_cursor must be of the form '<iso>|<id>' (e.g. '2026-05-22T10:30:00.000Z|7392')",
        },
      },
      400
    );
  }
  const revisionsCursorParsed = parseCursorQuery(
    c.req.query("revisions_cursor")
  );
  if (revisionsCursorParsed === INVALID_CURSOR) {
    return c.json(
      {
        error: {
          code: "INVALID_QUERY",
          message:
            "revisions_cursor must be of the form '<iso>|<id>' (e.g. '2026-05-22T10:30:00.000Z|7392')",
        },
      },
      400
    );
  }
  const eventsCursorParsed = parseCursorQuery(c.req.query("events_cursor"));
  if (eventsCursorParsed === INVALID_CURSOR) {
    return c.json(
      {
        error: {
          code: "INVALID_QUERY",
          message:
            "events_cursor must be of the form '<iso>|<id>' (e.g. '2026-05-22T10:30:00.000Z|7392')",
        },
      },
      400
    );
  }
  const observationsLimitParsed = parsePositiveIntQuery(
    c.req.query("observations_limit")
  );
  if (observationsLimitParsed === INVALID_INT) {
    return c.json(
      {
        error: {
          code: "INVALID_QUERY",
          message: "observations_limit must be a positive integer",
        },
      },
      400
    );
  }
  const revisionsLimitParsed = parsePositiveIntQuery(
    c.req.query("revisions_limit")
  );
  if (revisionsLimitParsed === INVALID_INT) {
    return c.json(
      {
        error: {
          code: "INVALID_QUERY",
          message: "revisions_limit must be a positive integer",
        },
      },
      400
    );
  }
  const eventsLimitParsed = parsePositiveIntQuery(c.req.query("events_limit"));
  if (eventsLimitParsed === INVALID_INT) {
    return c.json(
      {
        error: {
          code: "INVALID_QUERY",
          message: "events_limit must be a positive integer",
        },
      },
      400
    );
  }

  // Build options object by spreading conditionally — exactOptionalPropertyTypes
  // is on, so we must NOT pass `since: undefined` for absent params; we
  // omit the key entirely instead. Slightly more verbose but the types
  // (`since?: Date`) then properly express "absent" vs "present".
  const traceOpts: Parameters<typeof readProductTrace>[1] = {
    tenantId,
    merchantId,
    productId,
    ...(sinceParsed !== undefined ? { since: sinceParsed } : {}),
    ...(observationsLimitParsed !== undefined
      ? { observationsLimit: observationsLimitParsed }
      : {}),
    ...(revisionsLimitParsed !== undefined
      ? { revisionsLimit: revisionsLimitParsed }
      : {}),
    ...(eventsLimitParsed !== undefined
      ? { eventsLimit: eventsLimitParsed }
      : {}),
    ...(observationsCursorParsed !== undefined
      ? { observationsCursor: observationsCursorParsed }
      : {}),
    ...(revisionsCursorParsed !== undefined
      ? { revisionsCursor: revisionsCursorParsed }
      : {}),
    ...(eventsCursorParsed !== undefined
      ? { eventsCursor: eventsCursorParsed }
      : {}),
  };
  const result = await readProductTrace(deps.db, traceOpts);

  if (result === TRACE_PRODUCT_NOT_FOUND) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Product not found" } },
      404
    );
  }

  // Service-layer types are camelCase (TS conventions). The API surface
  // is snake_case (see `getProductById`, `getProductProvenanceTrace`).
  // We project at the handler boundary so service types stay ergonomic
  // but the wire shape stays consistent across endpoints.
  return c.json({ data: projectTraceToWire(result) });
}

// ---- Response projection: camelCase service types → snake_case wire shape ----

/**
 * Map the service-layer `ProductTraceResult` (camelCase) to the snake_case
 * API response. We keep the projection in one place — adding a field to the
 * service result automatically requires a deliberate change here, which
 * acts as a forcing function for the wire-contract review.
 */
function projectTraceToWire(r: ProductTraceResult): Record<string, unknown> {
  const p = r.product;
  return {
    product: {
      product_id: p.productId,
      tenant_id: p.tenantId,
      merchant_id: p.merchantId,
      primary_identifier: p.primaryIdentifier,
      identity: p.identity,
      family: p.family,
      status: p.status,
      values: p.values,
      winning_values: p.winningValues,
      schema_version: p.schemaVersion,
      current_revision_id: p.currentRevisionId,
      parent_product_id: p.parentProductId,
      merged_into_product_id: p.mergedIntoProductId,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
    },
    observations_by_attribute: r.observationsByAttribute,
    pricing_observations: r.pricingObservations.map((row) => ({
      observation_id: row.observationId,
      product_id: row.productId,
      tenant_id: row.tenantId,
      channel_id: row.channelId,
      locale: row.locale,
      source: row.source,
      source_record_id: row.sourceRecordId,
      currency: row.currency,
      tiers: row.tiers,
      price_per_unit: row.pricePerUnit,
      observed_at: row.observedAt,
      ingested_at: row.ingestedAt,
      artifact_id: row.artifactId,
    })),
    inventory_observations: r.inventoryObservations.map((row) => ({
      observation_id: row.observationId,
      product_id: row.productId,
      tenant_id: row.tenantId,
      channel_id: row.channelId,
      location_id: row.locationId,
      qty: row.qty,
      click_collect_eligible: row.clickCollectEligible,
      purchase_limit: row.purchaseLimit,
      backorder_allowed: row.backorderAllowed,
      source: row.source,
      source_record_id: row.sourceRecordId,
      observed_at: row.observedAt,
      ingested_at: row.ingestedAt,
      artifact_id: row.artifactId,
    })),
    revisions: r.revisions.map((row) => ({
      revision_id: row.revisionId,
      ingested_at: row.ingestedAt,
      observed_at: row.observedAt,
      revision_reason: row.revisionReason,
      source_kind: row.sourceKind,
      source_record_id: row.sourceRecordId,
      triggered_by_artifact_id: row.triggeredByArtifactId,
      actor: row.actor,
      diff: row.diff,
      suppress_outbound: row.suppressOutbound,
    })),
    reconciliation_overrides: r.reconciliationOverrides.map((row) => ({
      override_id: row.overrideId,
      attribute_code: row.attributeCode,
      channel_code: row.channelCode,
      locale_code: row.localeCode,
      frozen_value: row.frozenValue,
      frozen_until: row.frozenUntil,
      actor: row.actor,
      rationale: row.rationale,
      created_at: row.createdAt,
    })),
    events: r.events.map((row) => ({
      event_id: row.eventId,
      event_type: row.eventType,
      payload: row.payload,
      triggered_by: row.triggeredBy,
      occurred_at: row.occurredAt,
      published_at: row.publishedAt,
      publish_attempts: row.publishAttempts,
    })),
    window: {
      since: r.window.since,
      until: r.window.until,
    },
    pagination: {
      observations_next_cursor: r.pagination.observationsNextCursor,
      revisions_next_cursor: r.pagination.revisionsNextCursor,
      events_next_cursor: r.pagination.eventsNextCursor,
    },
  };
}
