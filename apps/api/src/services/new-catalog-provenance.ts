// New-schema provenance reader — backs `GET /products/:product_id/provenance/:attribute_code`
// (Task 4.5, spec §20).
//
// Purpose
// -------
// Return the FULL chain that produced the currently-winning value for one
// (product, attribute, channel, locale) leaf:
//
//   winning_value → source_priority rule that picked it → underlying
//   observation → source artifact pointer
//
// Used by admin / debugging UIs to answer "why does this product show
// $79.95 and not $99 from CSV?" — one HTTP call, no JOIN gymnastics
// required on the consumer.
//
// Design decisions
// ----------------
// 1. **Local duplication of `loadActiveRules`**: catalog-service's
//    `_internal.ts` is package-private. Rather than promote it to a
//    public export for a second consumer (this handler), we duplicate
//    the ~25-line SELECT here. Matches the precedent set by the
//    watchdog drift-detector (`drift-detector.ts` decision 2).
// 2. **`raw_payload_pointer: null`** in v1 — aonex has no S3 / object
//    storage wiring yet. The artifact_id flows through (so the
//    Phase 5+ UI can build a pointer once storage lands), but the
//    canonical raw-bytes URL is null until then.
// 3. **`channel` default `"_unscoped"`** for channel-agnostic
//    attributes (brand, etc.) — matches the writer convention in
//    `catalog-write.ts`.
// 4. **Missing attribute → returns a result with `winner: null`**
//    (NOT throws / NOT returns null), so the handler can ship a
//    200 with explicit null fields. That distinguishes "no observations
//    for this attribute" from "product doesn't exist" (which IS a 404).
// 5. **Channel-code → channel-UUID translation for side tables**: for
//    pricing/inventory the side-table `channel_id` column is a UUID,
//    but the public endpoint takes the channel CODE (e.g. `shopify-au`).
//    We translate via `(tenantId, channelKind)` — splitting the code on
//    `-` and taking the first segment as kind. Mirrors
//    `resolveChannelByCode` in
//    `apps/worker/src/services/new-catalog-link-path.ts`.

import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import {
  pickWinner,
  type PickWinnerObservation,
  type PickWinnerResult,
  type SourcePriorityRule,
} from "@aonex/catalog-service";

// ---- Public types ----------------------------------------------------------

export interface ProvenanceArgs {
  tenantId: string;
  merchantId: string;
  productId: string;
  attributeCode: string;
  channel: string;
  locale: string;
}

export interface ProvenanceResult {
  attribute: string;
  channel: string;
  locale: string;
  winner: unknown;
  rule_fired: {
    rule_id: number | "wildcard";
    source_glob: string;
    priority: number;
  } | null;
  /** bigint serialised as number for side-table observations; null for JSONB observations (no row id). */
  observation_id: number | null;
  observation_source: string | null;
  observation_observed_at: string | null;
  /** UUID of the source_artifact, when known. JSONB observations carry it on `extras.artifactId`; side-table rows carry it on the `artifact_id` column. */
  artifact_id: string | null;
  /** Canonical raw-bytes URL. Null in v1 (no object-storage wiring) — Phase 5+ populates it. */
  raw_payload_pointer: string | null;
}

/**
 * Sentinel returned by `readProvenance` to distinguish "product not found"
 * (404) from "product exists but the attribute leaf is empty" (200 with
 * null winner). Callers map this directly to a 404 in the handler.
 */
export const PRODUCT_NOT_FOUND = Symbol("product-not-found");
export type ProductNotFound = typeof PRODUCT_NOT_FOUND;

// ---- Internal types --------------------------------------------------------

/** Shape of one observation in `catalog_products.values[attr][channel][locale][]`. */
interface ValuesObservation {
  source: string;
  source_record_id: string;
  value: unknown;
  confidence: number;
  observed_at: string;
  extras?: Record<string, unknown>;
}

/** Pairs a `PickWinnerObservation` with side-channel metadata the public response needs. */
interface EnrichedObservation extends PickWinnerObservation {
  /** Side-table row id; null for JSONB observations. */
  observationId: number | null;
  /** artifactId from extras / side-table row, if any. */
  artifactId: string | null;
}

// ---- Local rules loader (decision 1) --------------------------------------

/**
 * Selects active `source_priority` rules for the given tenant + attribute.
 * Same WHERE clause as `reconciler/_internal.ts:loadActiveRules` and
 * watchdog's `drift-detector.ts:loadRules`. Filtering in SQL keeps the
 * result set bounded even when source_priority grows.
 */
async function loadRules(
  db: DrizzleClient,
  tenantId: string,
  attributeCodes: string[]
): Promise<SourcePriorityRule[]> {
  if (attributeCodes.length === 0) return [];
  const attributeFilter =
    attributeCodes.length === 1
      ? eq(schema.sourcePriority.attributeCode, attributeCodes[0]!)
      : inArray(schema.sourcePriority.attributeCode, attributeCodes);

  const rows = await db
    .select({
      ruleId: schema.sourcePriority.ruleId,
      attributeCode: schema.sourcePriority.attributeCode,
      sourceGlob: schema.sourcePriority.sourceGlob,
      channelScope: schema.sourcePriority.channelScope,
      priority: schema.sourcePriority.priority,
    })
    .from(schema.sourcePriority)
    .where(
      and(
        isNull(schema.sourcePriority.effectiveTo),
        or(
          isNull(schema.sourcePriority.tenantId),
          eq(schema.sourcePriority.tenantId, tenantId)
        ),
        or(isNull(schema.sourcePriority.attributeCode), attributeFilter)
      )
    );
  return rows.map((r) => ({
    ruleId: r.ruleId,
    attributeCode: r.attributeCode,
    sourceGlob: r.sourceGlob,
    channelScope: r.channelScope,
    priority: r.priority,
  }));
}

// ---- Channel-code → channel-UUID lookup -----------------------------------

/**
 * Resolve a (tenantId, channelCode) pair to a `channels.channel_id` UUID.
 *
 * Channel codes follow the writer convention emitted by
 * `channelCodeFromUrl(sourceUrl)` and stored on side-table rows:
 *   `${channelKind}-${region}` (e.g. `shopify-au`)
 *
 * We split on `-` and take the first segment as the channelKind, then
 * SELECT the first matching `channels` row for the tenant. Returns null
 * when no row exists.
 *
 * Mirrors `resolveChannelByCode` in
 * `apps/worker/src/services/new-catalog-link-path.ts` (kept thin here —
 * we don't gate on the KNOWN_CHANNEL_KINDS allow-list because the
 * provenance reader is a debug/admin tool and a null return is a benign
 * "no winner" rather than a security-relevant boundary).
 */
async function resolveChannelIdByCode(
  db: DrizzleClient,
  tenantId: string,
  channelCode: string
): Promise<string | null> {
  if (channelCode === "_unscoped") return null;
  const derivedKind = channelCode.split("-")[0] ?? "";
  if (!derivedKind) return null;
  const row = await db.query.channels.findFirst({
    where: (c, { and, eq }) =>
      and(eq(c.tenantId, tenantId), eq(c.channelKind, derivedKind)),
  });
  return row?.channelId ?? null;
}

// ---- Public API ------------------------------------------------------------

/**
 * Cap on side-table observations loaded per request. Matches the watchdog's
 * `OBSERVATION_LOOKBACK_LIMIT` — past ~200 history points the marginal
 * value of older rows is near zero for "who picked the current winner".
 */
const OBSERVATION_LOOKBACK_LIMIT = 200;

/**
 * Read provenance for one (product, attribute, channel, locale) leaf.
 *
 * Returns:
 *   - `PRODUCT_NOT_FOUND` when no catalog_products row matches
 *     `(tenantId, productId)` — handler maps to 404.
 *     ALSO returned on a tenant-match but merchant-mismatch row, so the
 *     cross-merchant boundary collapses to a 404 (not 403) without
 *     leaking row existence.
 *   - `ProvenanceResult` (winner may be null) otherwise — handler maps
 *     to 200 even when winner is null, distinguishing "no observations"
 *     (empty leaf, valid product) from "no product" (404).
 *
 * Read-only — no writes, no advisory locks. Safe to call concurrently.
 */
export async function readProvenance(
  db: DrizzleClient,
  args: ProvenanceArgs
): Promise<ProvenanceResult | ProductNotFound> {
  const { tenantId, merchantId, productId, attributeCode, channel, locale } =
    args;

  // 1. Load the product. Tenant-scoped first so a cross-tenant row maps
  //    to PRODUCT_NOT_FOUND, then enforce the merchant boundary in
  //    application code (same pattern as Task 4.4 — collapses to 404).
  const productRows = await db
    .select({
      productId: schema.catalogProducts.productId,
      tenantId: schema.catalogProducts.tenantId,
      merchantId: schema.catalogProducts.merchantId,
      values: schema.catalogProducts.values,
    })
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

  // 2. Load active rules for this attribute (plus any rules with
  //    attribute_code NULL, which apply to all attributes).
  const rules = await loadRules(db, tenantId, [attributeCode]);

  // 3. Build the observation list, branching by attribute family.
  let enriched: EnrichedObservation[] = [];

  if (attributeCode === "pricing") {
    enriched = await loadPricingObservations(db, {
      tenantId,
      productId,
      channel,
      locale,
    });
  } else if (attributeCode === "inventory") {
    enriched = await loadInventoryObservations(db, {
      tenantId,
      productId,
      channel,
    });
  } else {
    enriched = loadValuesObservations({
      values: (product.values ?? {}) as Record<
        string,
        Record<string, Record<string, ValuesObservation[]>>
      >,
      attributeCode,
      channel,
      locale,
    });
  }

  // 4. Empty leaf — return 200 with null fields (decision 4).
  if (enriched.length === 0) {
    return {
      attribute: attributeCode,
      channel,
      locale,
      winner: null,
      rule_fired: null,
      observation_id: null,
      observation_source: null,
      observation_observed_at: null,
      artifact_id: null,
      raw_payload_pointer: null,
    };
  }

  // 5. Run the projection. pickWinner returns a result with
  //    `observation` reference-equal to one of `enriched[]`, so we can
  //    pluck the side-channel fields (observationId / artifactId) back
  //    out without re-deriving identity.
  const result: PickWinnerResult | null = pickWinner({
    observations: enriched,
    rules,
    channel,
    attributeCode,
  });
  if (result === null) {
    // pickWinner only returns null for an empty observations list, which
    // we've already handled above — defensive branch.
    return {
      attribute: attributeCode,
      channel,
      locale,
      winner: null,
      rule_fired: null,
      observation_id: null,
      observation_source: null,
      observation_observed_at: null,
      artifact_id: null,
      raw_payload_pointer: null,
    };
  }

  const winningEnriched = result.observation as EnrichedObservation;
  const ruleFired =
    result.explanation.ruleId === "wildcard"
      ? null
      : {
          rule_id: result.explanation.ruleId,
          source_glob: result.explanation.sourceGlob,
          priority: result.explanation.priority,
        };

  return {
    attribute: attributeCode,
    channel,
    locale,
    winner: result.value,
    rule_fired: ruleFired,
    observation_id: winningEnriched.observationId,
    observation_source: result.observation.source,
    observation_observed_at: result.observation.observedAt.toISOString(),
    artifact_id: winningEnriched.artifactId,
    // Decision 2: null until object storage wiring lands in Phase 5+.
    raw_payload_pointer: null,
  };
}

// ---- Per-family observation loaders ---------------------------------------

/**
 * Load pricing observations for (product, channel, locale), translating
 * the channel CODE to channel UUID. Returns [] when the channel cannot
 * be resolved (e.g. typo) — that maps to a winner-is-null response
 * rather than a 4xx, since the channel param is part of the query and
 * a 200-with-empty is the right shape for an interactive admin UI.
 */
async function loadPricingObservations(
  db: DrizzleClient,
  args: {
    tenantId: string;
    productId: string;
    channel: string;
    locale: string;
  }
): Promise<EnrichedObservation[]> {
  const channelId = await resolveChannelIdByCode(
    db,
    args.tenantId,
    args.channel
  );
  if (!channelId) return [];

  const rows = await db
    .select({
      observationId: schema.catalogPricingObservations.observationId,
      source: schema.catalogPricingObservations.source,
      sourceRecordId: schema.catalogPricingObservations.sourceRecordId,
      currency: schema.catalogPricingObservations.currency,
      tiers: schema.catalogPricingObservations.tiers,
      pricePerUnit: schema.catalogPricingObservations.pricePerUnit,
      observedAt: schema.catalogPricingObservations.observedAt,
      artifactId: schema.catalogPricingObservations.artifactId,
    })
    .from(schema.catalogPricingObservations)
    .where(
      and(
        eq(schema.catalogPricingObservations.productId, args.productId),
        eq(schema.catalogPricingObservations.channelId, channelId),
        eq(schema.catalogPricingObservations.locale, args.locale)
      )
    )
    .orderBy(desc(schema.catalogPricingObservations.observedAt))
    .limit(OBSERVATION_LOOKBACK_LIMIT);

  return rows.map((r) => ({
    source: r.source,
    sourceRecordId: r.sourceRecordId ?? `${r.source}#unknown`,
    // Carry the same value shape the reconciler writes — see
    // async-debounced.ts:reconcilePricing. We don't need primaryAmount
    // here because the trace endpoint returns the raw winning value,
    // not the side-table projection.
    value: {
      source: r.source,
      currency: r.currency,
      tiers: r.tiers,
      pricePerUnit: r.pricePerUnit ?? null,
      observedAt: r.observedAt.toISOString(),
    },
    confidence: 1,
    observedAt: r.observedAt,
    observationId: r.observationId,
    artifactId: r.artifactId ?? null,
  }));
}

/**
 * Load inventory observations for (product, channel). Note: inventory
 * has no `locale` dimension — it has `location_id`. For the trace
 * endpoint we collapse across locations: callers asking "who set the
 * inventory winner for channel X" get the per-channel winner across
 * all locations. A future iteration can add `?location=<id>` once the
 * UI needs per-location traces.
 */
async function loadInventoryObservations(
  db: DrizzleClient,
  args: {
    tenantId: string;
    productId: string;
    channel: string;
  }
): Promise<EnrichedObservation[]> {
  const channelId = await resolveChannelIdByCode(
    db,
    args.tenantId,
    args.channel
  );
  if (!channelId) return [];

  const rows = await db
    .select({
      observationId: schema.catalogInventoryObservations.observationId,
      source: schema.catalogInventoryObservations.source,
      sourceRecordId: schema.catalogInventoryObservations.sourceRecordId,
      qty: schema.catalogInventoryObservations.qty,
      clickCollectEligible:
        schema.catalogInventoryObservations.clickCollectEligible,
      purchaseLimit: schema.catalogInventoryObservations.purchaseLimit,
      backorderAllowed:
        schema.catalogInventoryObservations.backorderAllowed,
      observedAt: schema.catalogInventoryObservations.observedAt,
      artifactId: schema.catalogInventoryObservations.artifactId,
    })
    .from(schema.catalogInventoryObservations)
    .where(
      and(
        eq(schema.catalogInventoryObservations.productId, args.productId),
        eq(schema.catalogInventoryObservations.channelId, channelId)
      )
    )
    .orderBy(desc(schema.catalogInventoryObservations.observedAt))
    .limit(OBSERVATION_LOOKBACK_LIMIT);

  return rows.map((r) => ({
    source: r.source,
    sourceRecordId: r.sourceRecordId ?? `${r.source}#unknown`,
    value: {
      source: r.source,
      qty: r.qty,
      clickCollectEligible: r.clickCollectEligible,
      purchaseLimit: r.purchaseLimit,
      backorderAllowed: r.backorderAllowed,
      observedAt: r.observedAt.toISOString(),
    },
    confidence: 1,
    observedAt: r.observedAt,
    observationId: r.observationId,
    artifactId: r.artifactId ?? null,
  }));
}

/**
 * Pluck observations for one (attribute, channel, locale) leaf out of the
 * `catalog_products.values` JSONB. Returns [] when the leaf is absent or
 * empty. No DB roundtrip here — the values JSONB came along on the same
 * SELECT that loaded the product.
 */
function loadValuesObservations(args: {
  values: Record<string, Record<string, Record<string, ValuesObservation[]>>>;
  attributeCode: string;
  channel: string;
  locale: string;
}): EnrichedObservation[] {
  const byChannel = args.values[args.attributeCode];
  if (!byChannel) return [];
  const byLocale = byChannel[args.channel];
  if (!byLocale) return [];
  const observations = byLocale[args.locale];
  if (!Array.isArray(observations) || observations.length === 0) return [];

  return observations.map((o) => {
    const extras = o.extras ?? {};
    const artifactId =
      typeof extras.artifactId === "string" ? extras.artifactId : null;
    return {
      source: o.source,
      sourceRecordId: o.source_record_id,
      value: o.value,
      confidence: o.confidence,
      observedAt: new Date(o.observed_at),
      // JSONB observations have no row id — they live inline as JSON.
      observationId: null,
      artifactId,
    };
  });
}
