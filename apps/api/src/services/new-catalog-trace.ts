// Product Trace reader — backs `GET /products/:product_id/trace` (Task 6.1, spec §20).
//
// Purpose
// -------
// Return a unified, single-product debug payload that admins / support can
// use to answer "what does this product look like and why?". Aggregates:
//   - Current `catalog_products` row state (identity, status, winning_values)
//   - Pricing observations (last N within the time window)
//   - Inventory observations (last N within the time window)
//   - Revisions (last N within the time window)
//   - Active reconciliation_overrides (NOT effective-dated, no time filter)
//   - Recent catalog_events (last N within the time window)
//   - `observationsByAttribute` projection from `catalog_products.values`
//
// Design decisions
// ----------------
// 1. **Framework-agnostic** — no `hono` imports. The Phase 6.2 CLI tool
//    imports this directly to dump a product trace without spinning up
//    the HTTP server. The handler maps query params + response shape; the
//    service does the read.
// 2. **Parallel queries (`Promise.all`)** — every side-table read is
//    independent of the others once the product row is resolved. Running
//    them concurrently keeps the heavy read's wall-clock close to the
//    slowest single query rather than their sum.
// 3. **Cursor encoding = ISO timestamp string** — pagination uses the
//    natural ordering column (`observed_at` / `ingested_at` / `occurred_at`)
//    as the cursor. ISO is human-debuggable, idempotent (same cursor →
//    same page even across restarts), and doesn't require server state.
//    Strict-less-than (`<`) avoids returning the cursor row again.
// 4. **Limit clamps server-side** — clients can pass any number; we clamp
//    to per-section caps (`observationsLimit ≤ 5000`, `revisionsLimit ≤ 200`,
//    `eventsLimit ≤ 200`). Never trust the wire.
// 5. **Active reconciliation_overrides** — the DB column is `frozen_until`
//    (NULL = permanent pin, TIMESTAMPTZ = time-bounded). Active = `frozen_until
//    IS NULL OR frozen_until > now()`. No time-window filter on overrides
//    themselves; the override list is small enough that returning all
//    active rows is cheap.
// 6. **observationsByAttribute** is derived from the in-memory
//    `catalog_products.values` JSONB — already nested by
//    attribute → channel → locale → [observations]. We just pass through
//    the shape, no re-query needed.
// 7. **Cross-tenant & cross-merchant safety** — mirrors Task 4.4 / 4.5.
//    A row in a different tenant OR different merchant returns
//    `PRODUCT_NOT_FOUND` (handler maps to 404). Never 403, never empty 200.

import { and, desc, eq, gt, gte, isNull, lt, or, type SQL } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";

/**
 * Strip out `undefined` entries from a list of SQL conditions, then AND
 * the rest. Drizzle's `and()` typings reject `undefined` directly, so we
 * fold conditional clauses (e.g. optional pagination cursors) here.
 */
function andOptional(
  ...conditions: Array<SQL<unknown> | undefined>
): SQL<unknown> | undefined {
  const filtered = conditions.filter(
    (c): c is SQL<unknown> => c !== undefined
  );
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];
  return and(...filtered);
}

// ---- Public types ----------------------------------------------------------

export interface ProductTraceQueryOptions {
  tenantId: string;
  merchantId: string;
  productId: string;
  /** Lower bound on observed_at / ingested_at / occurred_at. Defaults to now - 30d. */
  since?: Date;
  /**
   * Maximum number of pricing observations and inventory observations to return.
   * Default 1000, capped at 5000.
   */
  observationsLimit?: number;
  /** Default 50, capped at 200. */
  revisionsLimit?: number;
  /** Default 50, capped at 200. */
  eventsLimit?: number;
  /** Pagination cursor for observations (returns rows with observed_at < this). */
  observationsCursor?: Date;
  /** Pagination cursor for revisions (returns rows with ingested_at < this). */
  revisionsCursor?: Date;
  /** Pagination cursor for events (returns rows with occurred_at < this). */
  eventsCursor?: Date;
}

export interface ProductSnapshot {
  productId: string;
  tenantId: string;
  merchantId: string;
  primaryIdentifier: string;
  identity: unknown;
  family: string | null;
  status: string;
  values: unknown;
  winningValues: unknown;
  schemaVersion: string;
  currentRevisionId: number | null;
  parentProductId: string | null;
  mergedIntoProductId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PricingObservationRow {
  observationId: number;
  productId: string;
  tenantId: string;
  channelId: string;
  locale: string;
  source: string;
  sourceRecordId: string | null;
  currency: string;
  tiers: unknown;
  pricePerUnit: unknown;
  observedAt: string;
  ingestedAt: string;
  artifactId: string | null;
}

export interface InventoryObservationRow {
  observationId: number;
  productId: string;
  tenantId: string;
  channelId: string;
  locationId: string | null;
  qty: number;
  clickCollectEligible: boolean | null;
  purchaseLimit: number | null;
  backorderAllowed: boolean | null;
  source: string;
  sourceRecordId: string | null;
  observedAt: string;
  ingestedAt: string;
  artifactId: string | null;
}

export interface RevisionRow {
  revisionId: number;
  ingestedAt: string;
  observedAt: string | null;
  revisionReason: string;
  sourceKind: string | null;
  sourceRecordId: string | null;
  triggeredByArtifactId: string | null;
  actor: string | null;
  diff: unknown;
  suppressOutbound: boolean;
}

export interface ReconciliationOverrideRow {
  overrideId: number;
  attributeCode: string;
  channelCode: string;
  localeCode: string;
  frozenValue: unknown;
  frozenUntil: string | null;
  actor: string;
  rationale: string;
  createdAt: string;
}

export interface CatalogEventRow {
  eventId: number;
  eventType: string;
  payload: unknown;
  triggeredBy: string | null;
  occurredAt: string;
  publishedAt: string | null;
  publishAttempts: number;
}

/**
 * `observationsByAttribute[attributeCode][channelCode][localeCode]` is a list
 * of observations — passed straight through from `catalog_products.values`.
 * Pricing/inventory live in their own side-table arrays (see top-level
 * `pricingObservations` / `inventoryObservations`).
 */
export type ObservationsByAttribute = Record<
  string,
  Record<string, Record<string, unknown[]>>
>;

export interface ProductTraceResult {
  product: ProductSnapshot;
  observationsByAttribute: ObservationsByAttribute;
  pricingObservations: PricingObservationRow[];
  inventoryObservations: InventoryObservationRow[];
  revisions: RevisionRow[];
  reconciliationOverrides: ReconciliationOverrideRow[];
  events: CatalogEventRow[];
  window: {
    since: string;
    until: string;
  };
  pagination: {
    observationsNextCursor: string | null;
    revisionsNextCursor: string | null;
    eventsNextCursor: string | null;
  };
}

/**
 * Sentinel: product doesn't exist OR is cross-tenant / cross-merchant.
 * Handler maps to 404 without leaking which condition triggered it.
 */
export const PRODUCT_NOT_FOUND = Symbol("product-not-found");
export type ProductNotFound = typeof PRODUCT_NOT_FOUND;

// ---- Defaults & clamps -----------------------------------------------------

/** 30-day default window. Spec §20 — the trace is a recent-activity view. */
const DEFAULT_WINDOW_DAYS = 30;

const DEFAULT_OBSERVATIONS_LIMIT = 1000;
const MAX_OBSERVATIONS_LIMIT = 5000;
const DEFAULT_REVISIONS_LIMIT = 50;
const MAX_REVISIONS_LIMIT = 200;
const DEFAULT_EVENTS_LIMIT = 50;
const MAX_EVENTS_LIMIT = 200;

/** Clamp a positive-integer client value to [1, max]; fall back to default. */
function clampLimit(
  raw: number | undefined,
  defaultValue: number,
  max: number
): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return defaultValue;
  const n = Math.floor(raw);
  if (n > max) return max;
  return n;
}

// ---- Cursor helpers --------------------------------------------------------

/**
 * If `rows` is exactly `limit` long, the "next page exists" guess is on —
 * return the timestamp of the OLDEST row (which is the last one because
 * rows are sorted DESC) as the cursor. If shorter, no more pages.
 *
 * Note: this can yield a single false-positive cursor when the result set
 * size happens to be an exact multiple of `limit`. Clients that page until
 * they get an empty response handle this correctly.
 */
function nextCursorFromRows<T>(
  rows: T[],
  limit: number,
  pluckTs: (r: T) => Date
): string | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  if (!last) return null;
  return pluckTs(last).toISOString();
}

// ---- Public API ------------------------------------------------------------

/**
 * Read the unified product trace. Returns `PRODUCT_NOT_FOUND` for any
 * existence-leaking condition (no row, cross-tenant, cross-merchant).
 *
 * Read-only — no writes, no advisory locks. Safe for concurrent calls.
 *
 * Heavy read: emits up to 6 SELECTs (product, pricing obs, inventory obs,
 * revisions, overrides, events) in parallel. Caller should treat this as
 * an admin/debug surface, not a hot-path read.
 */
export async function readProductTrace(
  db: DrizzleClient,
  options: ProductTraceQueryOptions
): Promise<ProductTraceResult | ProductNotFound> {
  const {
    tenantId,
    merchantId,
    productId,
    observationsCursor,
    revisionsCursor,
    eventsCursor,
  } = options;

  // 1. Window. Default = now - 30d. `?since=` overrides.
  const until = new Date();
  const since =
    options.since ??
    new Date(until.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // 2. Limits — clamped server-side. Never trust client values.
  const observationsLimit = clampLimit(
    options.observationsLimit,
    DEFAULT_OBSERVATIONS_LIMIT,
    MAX_OBSERVATIONS_LIMIT
  );
  const revisionsLimit = clampLimit(
    options.revisionsLimit,
    DEFAULT_REVISIONS_LIMIT,
    MAX_REVISIONS_LIMIT
  );
  const eventsLimit = clampLimit(
    options.eventsLimit,
    DEFAULT_EVENTS_LIMIT,
    MAX_EVENTS_LIMIT
  );

  // 3. Resolve the product first (tenant-scoped). Cross-tenant or
  //    cross-merchant rows collapse to PRODUCT_NOT_FOUND (handler → 404).
  const productRows = await db
    .select()
    .from(schema.catalogProducts)
    .where(
      and(
        eq(schema.catalogProducts.productId, productId),
        eq(schema.catalogProducts.tenantId, tenantId)
      )
    )
    .limit(1);
  const product = productRows[0];
  if (!product) return PRODUCT_NOT_FOUND;
  if (product.merchantId !== merchantId) return PRODUCT_NOT_FOUND;

  // 4. Compose cursor-aware WHERE clauses for paginated sections.
  const pricingWhere = andOptional(
    eq(schema.catalogPricingObservations.productId, productId),
    gte(schema.catalogPricingObservations.observedAt, since),
    observationsCursor
      ? lt(schema.catalogPricingObservations.observedAt, observationsCursor)
      : undefined
  );
  const inventoryWhere = andOptional(
    eq(schema.catalogInventoryObservations.productId, productId),
    gte(schema.catalogInventoryObservations.observedAt, since),
    observationsCursor
      ? lt(schema.catalogInventoryObservations.observedAt, observationsCursor)
      : undefined
  );
  const revisionsWhere = andOptional(
    eq(schema.catalogProductRevisions.productId, productId),
    gte(schema.catalogProductRevisions.ingestedAt, since),
    revisionsCursor
      ? lt(schema.catalogProductRevisions.ingestedAt, revisionsCursor)
      : undefined
  );
  const eventsWhere = andOptional(
    eq(schema.catalogEvents.productId, productId),
    gte(schema.catalogEvents.occurredAt, since),
    eventsCursor
      ? lt(schema.catalogEvents.occurredAt, eventsCursor)
      : undefined
  );

  // 5. Fire all side-table queries in parallel. Independent — they hit
  //    different tables, no shared locks.
  const [
    pricingRows,
    inventoryRows,
    revisionRows,
    overrideRows,
    eventRows,
  ] = await Promise.all([
    db
      .select()
      .from(schema.catalogPricingObservations)
      .where(pricingWhere)
      .orderBy(desc(schema.catalogPricingObservations.observedAt))
      .limit(observationsLimit),
    db
      .select()
      .from(schema.catalogInventoryObservations)
      .where(inventoryWhere)
      .orderBy(desc(schema.catalogInventoryObservations.observedAt))
      .limit(observationsLimit),
    db
      .select()
      .from(schema.catalogProductRevisions)
      .where(revisionsWhere)
      .orderBy(desc(schema.catalogProductRevisions.ingestedAt))
      .limit(revisionsLimit),
    // Reconciliation overrides: active = NOT past their frozen_until.
    // No time-window filter on these (override list is small, and an old
    // override is still relevant if it's still active).
    db
      .select()
      .from(schema.reconciliationOverrides)
      .where(
        and(
          eq(schema.reconciliationOverrides.productId, productId),
          or(
            isNull(schema.reconciliationOverrides.frozenUntil),
            gt(schema.reconciliationOverrides.frozenUntil, until)
          )
        )
      )
      .orderBy(desc(schema.reconciliationOverrides.createdAt)),
    db
      .select()
      .from(schema.catalogEvents)
      .where(eventsWhere)
      .orderBy(desc(schema.catalogEvents.occurredAt))
      .limit(eventsLimit),
  ]);

  // 6. Project to the wire shape (ISO timestamps; preserve null-ness).
  const pricingObservations: PricingObservationRow[] = pricingRows.map((r) => ({
    observationId: Number(r.observationId),
    productId: r.productId,
    tenantId: r.tenantId,
    channelId: r.channelId,
    locale: r.locale,
    source: r.source,
    sourceRecordId: r.sourceRecordId,
    currency: r.currency,
    tiers: r.tiers,
    pricePerUnit: r.pricePerUnit ?? null,
    observedAt: r.observedAt.toISOString(),
    ingestedAt: r.ingestedAt.toISOString(),
    artifactId: r.artifactId ?? null,
  }));

  const inventoryObservations: InventoryObservationRow[] = inventoryRows.map(
    (r) => ({
      observationId: Number(r.observationId),
      productId: r.productId,
      tenantId: r.tenantId,
      channelId: r.channelId,
      locationId: r.locationId ?? null,
      qty: r.qty,
      clickCollectEligible: r.clickCollectEligible ?? null,
      purchaseLimit: r.purchaseLimit ?? null,
      backorderAllowed: r.backorderAllowed ?? null,
      source: r.source,
      sourceRecordId: r.sourceRecordId,
      observedAt: r.observedAt.toISOString(),
      ingestedAt: r.ingestedAt.toISOString(),
      artifactId: r.artifactId ?? null,
    })
  );

  const revisions: RevisionRow[] = revisionRows.map((r) => ({
    revisionId: Number(r.revisionId),
    ingestedAt: r.ingestedAt.toISOString(),
    observedAt: r.observedAt ? r.observedAt.toISOString() : null,
    revisionReason: r.revisionReason,
    sourceKind: r.sourceKind,
    sourceRecordId: r.sourceRecordId,
    triggeredByArtifactId: r.triggeredByArtifactId,
    actor: r.actor,
    diff: r.diff,
    suppressOutbound: r.suppressOutbound,
  }));

  const reconciliationOverrides: ReconciliationOverrideRow[] = overrideRows.map(
    (r) => ({
      overrideId: Number(r.overrideId),
      attributeCode: r.attributeCode,
      channelCode: r.channelCode,
      localeCode: r.localeCode,
      frozenValue: r.frozenValue,
      frozenUntil: r.frozenUntil ? r.frozenUntil.toISOString() : null,
      actor: r.actor,
      rationale: r.rationale,
      createdAt: r.createdAt.toISOString(),
    })
  );

  const events: CatalogEventRow[] = eventRows.map((r) => ({
    eventId: Number(r.eventId),
    eventType: r.eventType,
    payload: r.payload,
    triggeredBy: r.triggeredBy,
    occurredAt: r.occurredAt.toISOString(),
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
    publishAttempts: r.publishAttempts,
  }));

  // 7. observationsByAttribute — passthrough projection of catalog_products.values.
  //    Already structured as attr → channel → locale → array of observations.
  //    We DO NOT attempt to merge the side-table observations into this map;
  //    those have their own top-level arrays (pricingObservations /
  //    inventoryObservations) so the frontend can render them as time series.
  const observationsByAttribute: ObservationsByAttribute = projectValuesAsObservations(
    product.values as unknown
  );

  // 8. Combined "observations" cursor: pricing and inventory both stream
  //    through the same `observations_cursor` query param. The next cursor
  //    is the older of the two sections' next cursors (so the next page
  //    catches both up). If only one section is paginated, that's fine —
  //    its cursor wins.
  const pricingNext = nextCursorFromRows(
    pricingObservations,
    observationsLimit,
    (r) => new Date(r.observedAt)
  );
  const inventoryNext = nextCursorFromRows(
    inventoryObservations,
    observationsLimit,
    (r) => new Date(r.observedAt)
  );
  const observationsNextCursor = pickOlderCursor(pricingNext, inventoryNext);

  const revisionsNextCursor = nextCursorFromRows(
    revisions,
    revisionsLimit,
    (r) => new Date(r.ingestedAt)
  );
  const eventsNextCursor = nextCursorFromRows(
    events,
    eventsLimit,
    (r) => new Date(r.occurredAt)
  );

  return {
    product: {
      productId: product.productId,
      tenantId: product.tenantId,
      merchantId: product.merchantId,
      primaryIdentifier: product.primaryIdentifier,
      identity: product.identity,
      family: product.family,
      status: product.status,
      values: product.values,
      winningValues: product.winningValues,
      schemaVersion: product.schemaVersion,
      currentRevisionId: product.currentRevisionId,
      parentProductId: product.parentProductId,
      mergedIntoProductId: product.mergedIntoProductId,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    },
    observationsByAttribute,
    pricingObservations,
    inventoryObservations,
    revisions,
    reconciliationOverrides,
    events,
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
    },
    pagination: {
      observationsNextCursor,
      revisionsNextCursor,
      eventsNextCursor,
    },
  };
}

// ---- Internals -------------------------------------------------------------

/**
 * Pick the older of two ISO cursors (so callers paging both pricing and
 * inventory simultaneously catch up the slower one first). Either may be
 * null. If both are null, returns null.
 */
function pickOlderCursor(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

/**
 * Project `catalog_products.values` JSONB into the observationsByAttribute
 * shape — `{ [attr]: { [channel]: { [locale]: observations[] } } }`.
 *
 * Tolerates malformed inputs (non-objects, non-arrays) by skipping them,
 * since `values` is JSONB and the trace endpoint is a debug surface that
 * should never throw on user data.
 *
 * Note: pricing and inventory live in their own side tables, not in
 * `values`. They're surfaced via the top-level `pricingObservations` and
 * `inventoryObservations` arrays. This map only contains the attributes
 * the writer actually stores in `values` (title, brand, description, etc.).
 */
function projectValuesAsObservations(
  raw: unknown
): ObservationsByAttribute {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const values = raw as Record<string, unknown>;
  const result: ObservationsByAttribute = {};
  for (const [attrCode, byChannelRaw] of Object.entries(values)) {
    if (
      byChannelRaw === null ||
      typeof byChannelRaw !== "object" ||
      Array.isArray(byChannelRaw)
    ) {
      continue;
    }
    const byChannel = byChannelRaw as Record<string, unknown>;
    const channelMap: Record<string, Record<string, unknown[]>> = {};
    for (const [channelCode, byLocaleRaw] of Object.entries(byChannel)) {
      if (
        byLocaleRaw === null ||
        typeof byLocaleRaw !== "object" ||
        Array.isArray(byLocaleRaw)
      ) {
        continue;
      }
      const byLocale = byLocaleRaw as Record<string, unknown>;
      const localeMap: Record<string, unknown[]> = {};
      for (const [localeCode, obsRaw] of Object.entries(byLocale)) {
        if (Array.isArray(obsRaw)) {
          localeMap[localeCode] = obsRaw as unknown[];
        }
      }
      if (Object.keys(localeMap).length > 0) channelMap[channelCode] = localeMap;
    }
    if (Object.keys(channelMap).length > 0) result[attrCode] = channelMap;
  }
  return result;
}
