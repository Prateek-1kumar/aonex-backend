// Catalog redesign Phase 3.10 — drift detector (spec §13.3, plan §3.10).
//
// Risk addressed: a debounced reconciler task fails or is dropped (worker
// crash, queue eviction). Side-table observations land but
// `catalog_pricing_current` / `winning_values.pricing` never update. Readers
// then see stale winners. The tiered watchdog (continuous + hourly + daily)
// catches this by re-projecting winners and comparing against what's stored.
//
// detectDrift is read-only — it does NOT write. It loads:
//   1. catalog_products (identity, status, values JSONB, winning_values JSONB)
//   2. The latest pricing observations (catalog_pricing_observations) for
//      this product.
//   3. The latest inventory observations (catalog_inventory_observations).
//   4. The catalog_pricing_current and catalog_inventory_current rows.
// Then for each (attribute × channel × locale) leaf in values, runs
// `pickWinner` and compares the result against winning_values; for pricing
// and inventory, projects per (channel × locale / channel × location) the
// same way the async-debounced worker does — purely in memory — and
// compares against the stored _current rows.
//
// Design decisions (numbered for cross-reference in code review):
//   1. Reuse pickWinner + loadActiveRules from @aonex/catalog-service. We do
//      NOT re-implement them — drift detection MUST use the same projection
//      semantics as the writer. (If they diverged, the watchdog would chase
//      its own tail.)
//   2. Deep-equal: we duplicate the tiny JSON deep-equal here (~24 lines)
//      rather than promote reconciler/_internal.ts to a public export. The
//      internal helper is intentionally module-private; the cost of a
//      duplicate is low and keeps catalog-service's public surface minimal.
//   3. NULL location handling for inventory: groups under the sentinel UUID
//      `00000000-0000-0000-0000-000000000000` to match the DB-generated
//      `location_id_coalesced` column. Mirrors async-debounced.ts:64.
//   4. Empty-observations: if a product has no observations for a leaf
//      (pricing/inventory) but a stored _current row exists, that's drift
//      (orphan). Auto-fix would DELETE the orphan in a follow-up; the
//      report flags it with expected=null.
//   5. Tombstoned products: detectDrift does NOT gate on status. Callers
//      (the tier runners) skip status='merged_into' products since the
//      _current rows are intentionally cleared on merge. Calling detectDrift
//      on a tombstone is safe — with no observations, projection is empty,
//      so hasDrift=false.
//   6. We currently support pricing+inventory side-table drift detection
//      (the side-table types Phase 3 supports). Other reconciler-managed
//      attributes added in later phases will need their own _current-table
//      reads here.

import { desc, eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import {
  pickWinner,
  type PickWinnerObservation,
  type SourcePriorityRule
} from "@aonex/catalog-service";

// ---- Public types ----------------------------------------------------------

export interface WatchdogDeps {
  db: DrizzleClient;
}

export interface DriftReport {
  productId: string;
  tenantId: string;
  detectedAt: Date;
  hasDrift: boolean;
  driftAttributes: Array<{
    attributeCode: string;
    channel: string;
    locale: string;
    stored: unknown;
    expected: unknown;
  }>;
  driftPricingCurrentRows: Array<{
    channelId: string;
    locale: string;
    stored: { source: string; primaryAmount: number | null; tiers: unknown } | null;
    expected: { source: string; primaryAmount: number | null; tiers: unknown } | null;
  }>;
  driftInventoryCurrentRows: Array<{
    channelId: string;
    locationIdCoalesced: string;
    stored: { source: string; qty: number } | null;
    expected: { source: string; qty: number } | null;
  }>;
}

// ---- Stats shape (shared with tier runners) -------------------------------

export interface WatchdogStats {
  /** Total products examined this run. */
  sampled: number;
  /** Products with at least one drift (hasDrift=true). */
  driftFound: number;
  /** Products for which auto-fix completed without error. */
  autoFixed: number;
  durationMs: number;
  /** Count of drift instances broken down by attributeCode. */
  driftRateByAttribute: Record<string, number>;
}

// ---- Constants -------------------------------------------------------------

/** Mirrors async-debounced.ts (the single source of truth for the sentinel
 *  shape; if that constant ever moves to lib-utils, swap here as well). */
const NULL_LOCATION_SENTINEL = "00000000-0000-0000-0000-000000000000";

/** Matches async-debounced.ts. Generous window since drift detection is
 *  read-only and we want to consider the full observation history that the
 *  reconciler would have seen. */
const OBSERVATION_LOOKBACK_LIMIT = 200;

// ---- Internal shapes -------------------------------------------------------

interface ValuesObservation {
  source: string;
  source_record_id: string;
  value: unknown;
  confidence: number;
  observed_at: string; // ISO-8601
}

type ValuesJson = Record<
  string,
  Record<string, Record<string, ValuesObservation[]>>
>;

type WinningValuesJson = Record<string, unknown>;

interface PricingObservationRow {
  channelId: string;
  locale: string;
  source: string;
  sourceRecordId: string | null;
  currency: string;
  tiers: unknown;
  pricePerUnit: unknown;
  observedAt: Date;
}

interface InventoryObservationRow {
  channelId: string;
  locationId: string | null;
  qty: number;
  source: string;
  sourceRecordId: string | null;
  observedAt: Date;
}

interface PricingExpectedLeaf {
  source: string;
  primaryAmount: number | null;
  tiers: unknown;
}

interface InventoryExpectedLeaf {
  source: string;
  qty: number;
}

// ---- Deep-equal (see decision 2) ------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrB = b as unknown[];
    if (a.length !== arrB.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], arrB[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const ka = Object.keys(objA);
  const kb = Object.keys(objB);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

// ---- Local rules loader ---------------------------------------------------

/** Locally re-implemented (decision 2 — `_internal.ts` is module-private).
 *  Selects rules from source_priority filtered by tenant (null = global)
 *  and attributeCode (null = all). Same shape returned by the async-debounced
 *  worker's loader. */
async function loadRules(
  db: DrizzleClient,
  tenantId: string,
  attributeCodes: string[]
): Promise<SourcePriorityRule[]> {
  if (attributeCodes.length === 0) return [];
  const rows = await db
    .select({
      ruleId: schema.sourcePriority.ruleId,
      attributeCode: schema.sourcePriority.attributeCode,
      sourceGlob: schema.sourcePriority.sourceGlob,
      channelScope: schema.sourcePriority.channelScope,
      priority: schema.sourcePriority.priority,
      tenantId: schema.sourcePriority.tenantId,
      effectiveTo: schema.sourcePriority.effectiveTo
    })
    .from(schema.sourcePriority);
  // Filter in memory — count is bounded (a few dozen per tenant max). Avoids
  // re-deriving the multi-condition WHERE that loadActiveRules has internally.
  return rows
    .filter(
      (r) =>
        r.effectiveTo === null &&
        (r.tenantId === null || r.tenantId === tenantId) &&
        (r.attributeCode === null || attributeCodes.includes(r.attributeCode))
    )
    .map((r) => ({
      ruleId: r.ruleId,
      attributeCode: r.attributeCode,
      sourceGlob: r.sourceGlob,
      channelScope: r.channelScope,
      priority: r.priority
    }));
}

// ---- Public API ------------------------------------------------------------

/**
 * Compute a DriftReport for one product. Read-only: detects discrepancy
 * between (a) the recomputed winners (from values + side tables) and
 * (b) what's stored on catalog_products / catalog_*_current.
 *
 * No writes, no advisory locks — drift detection should be cheap and
 * concurrent-safe. The expected-vs-stored snapshot may be slightly racy if
 * a writer commits mid-projection, but the worst case is a transient
 * false-positive that the next tier sweep will see resolved.
 */
export async function detectDrift(
  deps: WatchdogDeps,
  productId: string
): Promise<DriftReport> {
  const { db } = deps;
  const detectedAt = new Date();

  const productRows = await db
    .select({
      productId: schema.catalogProducts.productId,
      tenantId: schema.catalogProducts.tenantId,
      values: schema.catalogProducts.values,
      winningValues: schema.catalogProducts.winningValues,
      status: schema.catalogProducts.status
    })
    .from(schema.catalogProducts)
    .where(eq(schema.catalogProducts.productId, productId))
    .limit(1);
  const product = productRows[0];
  if (!product) {
    throw new Error(`detectDrift: product ${productId} not found`);
  }

  const valuesJson = (product.values ?? {}) as ValuesJson;
  const winningValuesJson =
    (product.winningValues ?? {}) as WinningValuesJson;

  // 1. Compute drift for sync attributes (everything in values JSONB).
  const attributeCodes = Object.keys(valuesJson).filter(
    (k) => k !== "_meta" && k !== "pricing" && k !== "inventory"
  );
  // pricing/inventory aren't typically under values JSONB (they live in side
  // tables) — exclude defensively.

  const rules =
    attributeCodes.length > 0
      ? await loadRules(db, product.tenantId, attributeCodes)
      : [];

  const driftAttributes: DriftReport["driftAttributes"] = [];

  for (const attr of attributeCodes) {
    const attrValues = valuesJson[attr];
    if (!attrValues || typeof attrValues !== "object") continue;

    const priorForAttr =
      (winningValuesJson[attr] as
        | Record<string, Record<string, unknown>>
        | undefined) ?? {};

    for (const [channel, byLocale] of Object.entries(attrValues)) {
      if (!byLocale || typeof byLocale !== "object") continue;
      for (const [locale, observations] of Object.entries(byLocale)) {
        if (!Array.isArray(observations) || observations.length === 0) continue;
        const result = pickWinner({
          observations: observations.map(toPickWinnerObs),
          rules,
          channel,
          attributeCode: attr
        });
        if (result === null) continue;
        const stored = priorForAttr?.[channel]?.[locale];
        if (!deepEqual(stored, result.value)) {
          driftAttributes.push({
            attributeCode: attr,
            channel,
            locale,
            stored: stored ?? null,
            expected: result.value
          });
        }
      }
    }
  }

  // 2. Pricing drift.
  const driftPricingCurrentRows = await detectPricingDrift(
    db,
    product.productId,
    product.tenantId
  );

  // 3. Inventory drift.
  const driftInventoryCurrentRows = await detectInventoryDrift(
    db,
    product.productId,
    product.tenantId
  );

  const hasDrift =
    driftAttributes.length > 0 ||
    driftPricingCurrentRows.length > 0 ||
    driftInventoryCurrentRows.length > 0;

  return {
    productId: product.productId,
    tenantId: product.tenantId,
    detectedAt,
    hasDrift,
    driftAttributes,
    driftPricingCurrentRows,
    driftInventoryCurrentRows
  };
}

// ---- Pricing drift helper -------------------------------------------------

async function detectPricingDrift(
  db: DrizzleClient,
  productId: string,
  tenantId: string
): Promise<DriftReport["driftPricingCurrentRows"]> {
  // Mirror the read pattern from async-debounced.ts.
  const obsRows = (await db
    .select({
      channelId: schema.catalogPricingObservations.channelId,
      locale: schema.catalogPricingObservations.locale,
      source: schema.catalogPricingObservations.source,
      sourceRecordId: schema.catalogPricingObservations.sourceRecordId,
      currency: schema.catalogPricingObservations.currency,
      tiers: schema.catalogPricingObservations.tiers,
      pricePerUnit: schema.catalogPricingObservations.pricePerUnit,
      observedAt: schema.catalogPricingObservations.observedAt
    })
    .from(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.productId, productId))
    .orderBy(desc(schema.catalogPricingObservations.observedAt))
    .limit(OBSERVATION_LOOKBACK_LIMIT)) as PricingObservationRow[];

  const currentRows = await db
    .select({
      channelId: schema.catalogPricingCurrent.channelId,
      locale: schema.catalogPricingCurrent.locale,
      source: schema.catalogPricingCurrent.source,
      primaryAmount: schema.catalogPricingCurrent.primaryAmount,
      tiers: schema.catalogPricingCurrent.tiers
    })
    .from(schema.catalogPricingCurrent)
    .where(eq(schema.catalogPricingCurrent.productId, productId));

  const expectedByLeaf = new Map<string, PricingExpectedLeaf>();
  if (obsRows.length > 0) {
    const rules = await loadRules(db, tenantId, ["pricing"]);
    const groups = new Map<string, PricingObservationRow[]>();
    for (const row of obsRows) {
      const key = `${row.channelId}::${row.locale}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }
    for (const [key, bucket] of groups.entries()) {
      const observations: PickWinnerObservation[] = bucket.map((row) => ({
        source: row.source,
        sourceRecordId: row.sourceRecordId ?? `${row.source}#unknown`,
        value: {
          source: row.source,
          tiers: row.tiers,
          primaryAmount: extractPrimaryAmount(row.tiers)
        } satisfies PricingExpectedLeaf,
        confidence: 1,
        observedAt: row.observedAt
      }));
      const winner = pickWinner({
        observations,
        rules,
        channel: bucket[0]!.channelId,
        attributeCode: "pricing"
      });
      if (winner === null) continue;
      expectedByLeaf.set(key, winner.value as PricingExpectedLeaf);
    }
  }

  const storedByLeaf = new Map<
    string,
    { source: string; primaryAmount: number | null; tiers: unknown }
  >();
  for (const r of currentRows) {
    const key = `${r.channelId}::${r.locale}`;
    storedByLeaf.set(key, {
      source: r.source,
      primaryAmount:
        r.primaryAmount === null || r.primaryAmount === undefined
          ? null
          : Number(r.primaryAmount),
      tiers: r.tiers
    });
  }

  const drift: DriftReport["driftPricingCurrentRows"] = [];
  const allKeys = new Set<string>([
    ...expectedByLeaf.keys(),
    ...storedByLeaf.keys()
  ]);
  for (const key of allKeys) {
    const expected = expectedByLeaf.get(key) ?? null;
    const stored = storedByLeaf.get(key) ?? null;
    if (!leafEqual(expected, stored)) {
      const [channelId, locale] = key.split("::") as [string, string];
      drift.push({ channelId, locale, stored, expected });
    }
  }
  return drift;
}

// ---- Inventory drift helper -----------------------------------------------

async function detectInventoryDrift(
  db: DrizzleClient,
  productId: string,
  tenantId: string
): Promise<DriftReport["driftInventoryCurrentRows"]> {
  const obsRows = (await db
    .select({
      channelId: schema.catalogInventoryObservations.channelId,
      locationId: schema.catalogInventoryObservations.locationId,
      qty: schema.catalogInventoryObservations.qty,
      source: schema.catalogInventoryObservations.source,
      sourceRecordId: schema.catalogInventoryObservations.sourceRecordId,
      observedAt: schema.catalogInventoryObservations.observedAt
    })
    .from(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.productId, productId))
    .orderBy(desc(schema.catalogInventoryObservations.observedAt))
    .limit(OBSERVATION_LOOKBACK_LIMIT)) as InventoryObservationRow[];

  const currentRows = await db
    .select({
      channelId: schema.catalogInventoryCurrent.channelId,
      locationId: schema.catalogInventoryCurrent.locationId,
      qty: schema.catalogInventoryCurrent.qty,
      source: schema.catalogInventoryCurrent.source
    })
    .from(schema.catalogInventoryCurrent)
    .where(eq(schema.catalogInventoryCurrent.productId, productId));

  const expectedByLeaf = new Map<string, InventoryExpectedLeaf>();
  if (obsRows.length > 0) {
    const rules = await loadRules(db, tenantId, ["inventory"]);
    const groups = new Map<string, InventoryObservationRow[]>();
    for (const row of obsRows) {
      const locKey = row.locationId ?? NULL_LOCATION_SENTINEL;
      const key = `${row.channelId}::${locKey}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(row);
      groups.set(key, bucket);
    }
    for (const [key, bucket] of groups.entries()) {
      const observations: PickWinnerObservation[] = bucket.map((row) => ({
        source: row.source,
        sourceRecordId: row.sourceRecordId ?? `${row.source}#unknown`,
        value: {
          source: row.source,
          qty: row.qty
        } satisfies InventoryExpectedLeaf,
        confidence: 1,
        observedAt: row.observedAt
      }));
      const winner = pickWinner({
        observations,
        rules,
        channel: bucket[0]!.channelId,
        attributeCode: "inventory"
      });
      if (winner === null) continue;
      expectedByLeaf.set(key, winner.value as InventoryExpectedLeaf);
    }
  }

  const storedByLeaf = new Map<string, { source: string; qty: number }>();
  for (const r of currentRows) {
    const locKey = r.locationId ?? NULL_LOCATION_SENTINEL;
    const key = `${r.channelId}::${locKey}`;
    storedByLeaf.set(key, { source: r.source, qty: r.qty });
  }

  const drift: DriftReport["driftInventoryCurrentRows"] = [];
  const allKeys = new Set<string>([
    ...expectedByLeaf.keys(),
    ...storedByLeaf.keys()
  ]);
  for (const key of allKeys) {
    const expected = expectedByLeaf.get(key) ?? null;
    const stored = storedByLeaf.get(key) ?? null;
    if (!leafEqual(expected, stored)) {
      const [channelId, locationIdCoalesced] = key.split("::") as [
        string,
        string
      ];
      drift.push({
        channelId,
        locationIdCoalesced,
        stored,
        expected
      });
    }
  }
  return drift;
}

// ---- Helpers --------------------------------------------------------------

function toPickWinnerObs(o: ValuesObservation): PickWinnerObservation {
  return {
    source: o.source,
    sourceRecordId: o.source_record_id,
    value: o.value,
    confidence: o.confidence,
    observedAt: new Date(o.observed_at)
  };
}

/**
 * Extract a primary amount from a pricing tiers array. Mirrors
 * `extractPrimaryAmount` from catalog-service/reconciler/async-debounced.ts;
 * duplicated here because we want detect-drift to be independent of any
 * undocumented internal renames in async-debounced. (Trivial helper — keeps
 * the comparison apples-to-apples.)
 */
function extractPrimaryAmount(tiers: unknown): number | null {
  if (!Array.isArray(tiers)) return null;
  const typed = tiers as Array<{ kind?: string; amount?: number }>;
  const sale = typed.find((t) => t && t.kind === "sale");
  if (sale && typeof sale.amount === "number") return sale.amount;
  const list = typed.find((t) => t && t.kind === "list");
  if (list && typeof list.amount === "number") return list.amount;
  return null;
}

function leafEqual(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return deepEqual(a, b);
}
