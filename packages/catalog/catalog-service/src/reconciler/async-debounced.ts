// Catalog redesign — async-debounced reconciler worker (plan §3.6, spec §13.4 + §19).
//
// Spec §8.1 / §9.1 declare catalog_pricing_current and catalog_inventory_current
// as APP-MAINTAINED tables. Triggers and `REFRESH MATERIALIZED VIEW` were
// explicitly rejected in favour of an async-debounced TS worker — this module
// is the *only* update path for those `_current` tables.
//
// Flow per spec §13.4:
//   1. A pricing/inventory observation lands sync (catalog-write.ts inserts
//      into the *_observations side table).
//   2. The writer enqueues a BullMQ job with a 2-second debounce, keyed by
//      `${productId}:${attributeCode}` so repeat observations within the
//      window coalesce to a single recompute (BullMQ jobId semantics).
//   3. The worker:
//        - acquires a per-product transactional advisory lock,
//        - loads the latest N observations from the side table,
//        - groups by (channel × locale) for pricing or (channel × location)
//          for inventory,
//        - picks a winner via the pure `pickWinner` (shared with sync.ts),
//        - skips-no-winner-change if recomputed equals stored,
//        - UPSERTs `catalog_*_current`,
//        - patches `winning_values[attributeCode]` on `catalog_products`,
//        - emits `catalog.product.{pricing|inventory}_changed` into
//          `catalog_events` (outbox).
//     All five DB mutations live in one transaction.
//
// `_meta` placement mirrors sync.ts: `winning_values._meta` sibling block
// stamped with reconciler_version, rules_version, computed_at. The async
// path restamps `_meta` whenever it touches winning_values.
//
// Dependency injection: the plan sketch instantiated `new IORedis(...)` at
// module load. That's too eager for tests and bad practice for composition
// roots — `enqueueReconcilerJob` and `makeReconcilerWorker` take an injected
// `connection` (and `db` for the worker). The composition root (apps/worker,
// Phase 4) wires real connections; tests inject test connections.

import { Queue, Worker, type Job } from "bullmq";
import type IORedis from "ioredis";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import {
  RECONCILER_VERSION,
  pickWinner,
  type PickWinnerObservation,
  type SourcePriorityRule
} from "./pick-winner.js";

// ---- Constants -------------------------------------------------------------

/** Default debounce window per spec §13.4. */
const DEFAULT_DEBOUNCE_MS = 2_000;

/** Cap on observations the worker considers per recompute. The plan calls for
 *  "latest 10" — but practically we want the latest observation per
 *  (source, channel, locale/location) leaf, so we pull a generous window
 *  and let `pickWinner` decide. Keeps us well clear of pathological lag. */
const OBSERVATION_LOOKBACK_LIMIT = 200;

/** Sentinel UUID for the inventory `_current` PK when location_id is NULL.
 *  Mirrors the STORED generated column declared in migration 0012. We use
 *  it as the winning_values leaf key (since JSON has no null keys). */
const NULL_LOCATION_SENTINEL = "00000000-0000-0000-0000-000000000000";

/** Reconciler-managed attribute codes supported by this worker. */
export type ReconcilerAttributeCode = "pricing" | "inventory";

// ---- Public types ----------------------------------------------------------

export interface EnqueueReconcilerOpts {
  tenantId: string;
  productId: string;
  attributeCode: ReconcilerAttributeCode;
  /** Default = 2000ms. Set higher for batch tools, lower (or 0) for tests. */
  debounceMs?: number;
  /** Pinned rules version for the recompute (mirrors sync.ts contract). */
  rulesVersion?: number;
}

export interface ReconcilerJobData {
  tenantId: string;
  productId: string;
  attributeCode: ReconcilerAttributeCode;
  rulesVersion: number;
}

export interface ReconcilerDeps {
  connection: IORedis;
  db: DrizzleClient;
}

export interface ProcessResult {
  winnerChanged: boolean;
  /** Count of (channel × locale|location) leaves that were UPSERTed. */
  leavesWritten: number;
}

// ---- Queue naming ----------------------------------------------------------

/**
 * Per-tenant queue name. Isolation by tenant lets a noisy tenant get its own
 * worker pool / concurrency profile (plan §3.6 calls this out explicitly).
 *
 * NOTE: the plan sketch used `recon:${tenantId}` but BullMQ rejects `:` in
 * queue names (it uses `:` as its own internal Redis-key separator).
 * Matches the codebase's `nango.auth` / `ingestion.spine` dotted convention.
 */
export function reconcilerQueueName(tenantId: string): string {
  return `recon.${tenantId}`;
}

/** Stable BullMQ jobId so repeated enqueues within the debounce window
 *  collapse to one job. Spec §13.4 leans on BullMQ's same-jobId-replaces
 *  semantics — see test `enqueue with same (productId, attributeCode)`.
 *
 *  BullMQ disallows `:` in custom jobIds (reserved for repeatable-job
 *  encoding) so we use a `.` separator to match the queue-name convention. */
function reconcilerJobId(productId: string, attributeCode: string): string {
  return `${productId}.${attributeCode}`;
}

// ---- Enqueue ---------------------------------------------------------------

/**
 * Enqueue a debounced reconcile job. Idempotent — a second enqueue with the
 * same (productId, attributeCode) inside the debounce window does not stack
 * a second job. The caller (catalog-write) is expected to fire-and-forget.
 *
 * Returns the Job for tests; callers can ignore.
 */
export async function enqueueReconcilerJob(
  deps: { connection: IORedis },
  opts: EnqueueReconcilerOpts
): Promise<Job> {
  const queue = new Queue(reconcilerQueueName(opts.tenantId), {
    connection: deps.connection
  });
  try {
    const data: ReconcilerJobData = {
      tenantId: opts.tenantId,
      productId: opts.productId,
      attributeCode: opts.attributeCode,
      rulesVersion: opts.rulesVersion ?? 1
    };
    return await queue.add("reconcile", data, {
      delay: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      jobId: reconcilerJobId(opts.productId, opts.attributeCode),
      removeOnComplete: true,
      removeOnFail: 1000
    });
  } finally {
    // Don't keep the producer queue open across calls — the composition root
    // will hold a single Queue per tenant for hot paths. Here we keep the
    // helper stateless.
    await queue.close();
  }
}

// ---- Worker factory --------------------------------------------------------

/**
 * Construct a BullMQ Worker for one tenant's reconcile queue. The processor
 * delegates to `processReconcilerJob` so the business logic stays testable
 * without going through Redis. Composition-root wiring is Phase 4's job.
 */
export function makeReconcilerWorker(
  deps: ReconcilerDeps,
  opts: { tenantId: string; concurrency?: number }
): Worker {
  return new Worker(
    reconcilerQueueName(opts.tenantId),
    async (job: Job<ReconcilerJobData>) => processReconcilerJob(deps, job.data),
    { connection: deps.connection, concurrency: opts.concurrency ?? 4 }
  );
}

// ---- Pricing primary_amount helper ----------------------------------------

interface PriceTier {
  kind: string;
  amount: number;
}

/**
 * Extract the "primary" amount from a tier array for the `primary_amount`
 * column on `catalog_pricing_current`. Used by channel/price-range queries —
 * we want the lowest-bound price a customer would actually see, which is:
 *   1. First `kind: "sale"` tier if present (sale wins over list),
 *   2. else the first `kind: "list"` tier,
 *   3. else null (e.g. msrp-only — don't index).
 *
 * Exported for direct testing.
 */
export function extractPrimaryAmount(tiers: unknown): number | null {
  if (!Array.isArray(tiers)) return null;
  const typed = tiers as PriceTier[];
  const sale = typed.find((t) => t && t.kind === "sale");
  if (sale && typeof sale.amount === "number") return sale.amount;
  const list = typed.find((t) => t && t.kind === "list");
  if (list && typeof list.amount === "number") return list.amount;
  return null;
}

// ---- Shared helpers --------------------------------------------------------

interface WinningValuesMeta {
  reconciler_version: string;
  rules_version: number;
  computed_at: string;
}

type WinningValuesJson = Record<string, unknown> & {
  _meta?: WinningValuesMeta;
};

/** Deep-equal good enough for our JSONB winning-value comparison. Local copy
 *  of the helper in sync.ts — keeping them independent avoids cross-module
 *  coupling for a 20-line helper. */
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

async function loadActiveRules(
  tx: DrizzleClient,
  tenantId: string,
  attributeCode: string
): Promise<SourcePriorityRule[]> {
  const rows = await tx
    .select({
      ruleId: schema.sourcePriority.ruleId,
      attributeCode: schema.sourcePriority.attributeCode,
      sourceGlob: schema.sourcePriority.sourceGlob,
      channelScope: schema.sourcePriority.channelScope,
      priority: schema.sourcePriority.priority
    })
    .from(schema.sourcePriority)
    .where(
      and(
        isNull(schema.sourcePriority.effectiveTo),
        or(
          isNull(schema.sourcePriority.tenantId),
          eq(schema.sourcePriority.tenantId, tenantId)
        ),
        or(
          isNull(schema.sourcePriority.attributeCode),
          inArray(schema.sourcePriority.attributeCode, [attributeCode])
        )
      )
    );
  return rows.map((r) => ({
    ruleId: r.ruleId,
    attributeCode: r.attributeCode,
    sourceGlob: r.sourceGlob,
    channelScope: r.channelScope,
    priority: r.priority
  }));
}

// ---- Public API ------------------------------------------------------------

/**
 * Worker body — extracted so tests can drive it without BullMQ. Spec §13.4:
 *   - per-product advisory lock,
 *   - read latest N observations,
 *   - pickWinner per leaf,
 *   - skip-no-winner-change,
 *   - upsert *_current + winning_values + outbox event,
 *   - all in one transaction.
 *
 * Empty-observations is a clean no-op (returns winnerChanged=false) — the
 * worker may legitimately race ahead of partition activity or be called
 * after a merge wipe.
 */
export async function processReconcilerJob(
  deps: ReconcilerDeps,
  data: ReconcilerJobData
): Promise<ProcessResult> {
  const { db } = deps;
  if (data.attributeCode === "pricing") {
    return reconcilePricing(db, data);
  }
  if (data.attributeCode === "inventory") {
    return reconcileInventory(db, data);
  }
  // Future: listings/promotions (plan §3.6 reserves them). For now, refuse
  // loudly so a typo doesn't silently no-op.
  throw new Error(
    `processReconcilerJob: unsupported attributeCode "${data.attributeCode}"`
  );
}

// ---- Pricing branch --------------------------------------------------------

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

/** Shape of a winning_values.pricing leaf. Keep it self-describing — readers
 *  (channel APIs, search indexers) consume this directly. */
interface PricingWinnerValue {
  source: string;
  currency: string;
  tiers: unknown;
  pricePerUnit: unknown;
  observedAt: string;
}

async function reconcilePricing(
  db: DrizzleClient,
  data: ReconcilerJobData
): Promise<ProcessResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DrizzleClient;

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${data.productId}))`
    );

    // Load product row (we patch winning_values back). The advisory lock
    // already serialises concurrent reconciles for this product.
    const productRows = await tx
      .select({
        productId: schema.catalogProducts.productId,
        tenantId: schema.catalogProducts.tenantId,
        winningValues: schema.catalogProducts.winningValues
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, data.productId))
      .limit(1);
    const product = productRows[0];
    if (!product) {
      // Product disappeared (merge/delete) between enqueue and dequeue.
      // Clean no-op; the merged-into product will get its own reconcile.
      return { winnerChanged: false, leavesWritten: 0 };
    }

    // Pull recent observations for this product, newest first. We could
    // window per (channel, locale) but the volume is bounded by the debounce
    // window so a flat newest-first slice is cheaper.
    const obsRows = (await tx
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
      .where(eq(schema.catalogPricingObservations.productId, data.productId))
      .orderBy(desc(schema.catalogPricingObservations.observedAt))
      .limit(OBSERVATION_LOOKBACK_LIMIT)) as PricingObservationRow[];

    if (obsRows.length === 0) {
      return { winnerChanged: false, leavesWritten: 0 };
    }

    const rules = await loadActiveRules(tx, product.tenantId, "pricing");

    // Group observations by (channelId, locale) → each becomes one
    // `catalog_pricing_current` row + one winning_values leaf.
    const groups = new Map<string, PricingObservationRow[]>();
    for (const row of obsRows) {
      const key = `${row.channelId}	${row.locale}`;
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = [];
        groups.set(key, bucket);
      }
      bucket.push(row);
    }

    const priorWinningValues =
      (product.winningValues ?? {}) as WinningValuesJson;
    const priorPricing =
      (priorWinningValues.pricing as
        | Record<string, Record<string, unknown>>
        | undefined) ?? {};
    const nextPricing: Record<string, Record<string, PricingWinnerValue>> = {};

    let anyChange = false;
    let leavesWritten = 0;

    for (const [key, bucket] of groups.entries()) {
      const [channelId, locale] = key.split("\t") as [string, string];

      const observations: PickWinnerObservation[] = bucket.map((row) => ({
        source: row.source,
        sourceRecordId: row.sourceRecordId ?? `${row.source}#unknown`,
        // The `value` passed to pickWinner is the full pricing payload —
        // tiers + currency + the source-specific extras. pickWinner only
        // uses `source` and `observedAt` to pick; the `value` is what comes
        // back out.
        value: {
          source: row.source,
          currency: row.currency,
          tiers: row.tiers,
          pricePerUnit: row.pricePerUnit,
          observedAt: row.observedAt.toISOString()
        } satisfies PricingWinnerValue,
        confidence: 1,
        observedAt: row.observedAt
      }));

      const winner = pickWinner({
        observations,
        rules,
        channel: channelId,
        attributeCode: "pricing"
      });
      if (winner === null) continue;

      const newValue = winner.value as PricingWinnerValue;
      const priorValue = priorPricing[channelId]?.[locale];
      const changed = !deepEqual(priorValue, newValue);

      // Always rebuild the next pricing block so we represent the
      // recomputed shape; skip-no-winner-change only suppresses the WRITE.
      if (!nextPricing[channelId]) nextPricing[channelId] = {};
      nextPricing[channelId]![locale] = newValue;

      if (!changed) continue;
      anyChange = true;

      // Find the underlying row for the writeable columns. The winner's
      // value carries everything we need EXCEPT sourceRecordId is not on
      // catalog_pricing_current (it's an observation-only concept).
      const winningRow = bucket.find(
        (r) =>
          r.source === newValue.source &&
          r.observedAt.toISOString() === newValue.observedAt
      );
      if (!winningRow) {
        // Should be unreachable — winner came from this bucket.
        throw new Error(
          `reconcilePricing: lost winning row for ${channelId}/${locale}`
        );
      }

      await tx.execute(sql`
        INSERT INTO catalog_pricing_current
          (product_id, channel_id, locale, source, currency, tiers,
           price_per_unit, primary_amount, observed_at)
        VALUES
          (${data.productId}, ${channelId}, ${locale}, ${winningRow.source},
           ${winningRow.currency},
           ${JSON.stringify(winningRow.tiers)}::jsonb,
           ${winningRow.pricePerUnit === null || winningRow.pricePerUnit === undefined
             ? null
             : JSON.stringify(winningRow.pricePerUnit)}::jsonb,
           ${extractPrimaryAmount(winningRow.tiers)},
           ${winningRow.observedAt})
        ON CONFLICT (product_id, channel_id, locale) DO UPDATE SET
          source         = EXCLUDED.source,
          currency       = EXCLUDED.currency,
          tiers          = EXCLUDED.tiers,
          price_per_unit = EXCLUDED.price_per_unit,
          primary_amount = EXCLUDED.primary_amount,
          observed_at    = EXCLUDED.observed_at
      `);
      leavesWritten++;

      // Outbox event per spec §19. Payload shape from the spec:
      // { productId, channel, oldValue, newValue }.
      await tx.insert(schema.catalogEvents).values({
        eventType: "catalog.product.pricing_changed",
        productId: data.productId,
        tenantId: product.tenantId,
        payload: {
          productId: data.productId,
          channel: channelId,
          locale,
          oldValue: priorValue ?? null,
          newValue
        },
        triggeredBy: "reconciler:async"
      });
    }

    // Patch winning_values only if at least one leaf changed.
    if (anyChange) {
      const nextWinningValues: WinningValuesJson = { ...priorWinningValues };
      nextWinningValues.pricing = nextPricing;
      const computedAt = new Date();
      nextWinningValues._meta = {
        reconciler_version: RECONCILER_VERSION,
        rules_version: data.rulesVersion,
        computed_at: computedAt.toISOString()
      };
      await tx
        .update(schema.catalogProducts)
        .set({ winningValues: nextWinningValues, updatedAt: computedAt })
        .where(eq(schema.catalogProducts.productId, data.productId));
    }

    return { winnerChanged: anyChange, leavesWritten };
  });
}

// ---- Inventory branch ------------------------------------------------------

interface InventoryObservationRow {
  channelId: string;
  locationId: string | null;
  qty: number;
  clickCollectEligible: boolean | null;
  purchaseLimit: number | null;
  backorderAllowed: boolean | null;
  source: string;
  sourceRecordId: string | null;
  observedAt: Date;
}

interface InventoryWinnerValue {
  source: string;
  qty: number;
  clickCollectEligible: boolean | null;
  purchaseLimit: number | null;
  backorderAllowed: boolean | null;
  observedAt: string;
}

async function reconcileInventory(
  db: DrizzleClient,
  data: ReconcilerJobData
): Promise<ProcessResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DrizzleClient;

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${data.productId}))`
    );

    const productRows = await tx
      .select({
        productId: schema.catalogProducts.productId,
        tenantId: schema.catalogProducts.tenantId,
        winningValues: schema.catalogProducts.winningValues
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, data.productId))
      .limit(1);
    const product = productRows[0];
    if (!product) {
      return { winnerChanged: false, leavesWritten: 0 };
    }

    const obsRows = (await tx
      .select({
        channelId: schema.catalogInventoryObservations.channelId,
        locationId: schema.catalogInventoryObservations.locationId,
        qty: schema.catalogInventoryObservations.qty,
        clickCollectEligible:
          schema.catalogInventoryObservations.clickCollectEligible,
        purchaseLimit: schema.catalogInventoryObservations.purchaseLimit,
        backorderAllowed: schema.catalogInventoryObservations.backorderAllowed,
        source: schema.catalogInventoryObservations.source,
        sourceRecordId: schema.catalogInventoryObservations.sourceRecordId,
        observedAt: schema.catalogInventoryObservations.observedAt
      })
      .from(schema.catalogInventoryObservations)
      .where(eq(schema.catalogInventoryObservations.productId, data.productId))
      .orderBy(desc(schema.catalogInventoryObservations.observedAt))
      .limit(OBSERVATION_LOOKBACK_LIMIT)) as InventoryObservationRow[];

    if (obsRows.length === 0) {
      return { winnerChanged: false, leavesWritten: 0 };
    }

    const rules = await loadActiveRules(tx, product.tenantId, "inventory");

    // Group by (channelId, location_coalesced). Spec §9.1: NULL location
    // collapses to the sentinel for uniqueness. We use the same sentinel as
    // the winning_values leaf key so reads round-trip cleanly.
    const groups = new Map<string, InventoryObservationRow[]>();
    for (const row of obsRows) {
      const locKey = row.locationId ?? NULL_LOCATION_SENTINEL;
      const key = `${row.channelId}	${locKey}`;
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = [];
        groups.set(key, bucket);
      }
      bucket.push(row);
    }

    const priorWinningValues =
      (product.winningValues ?? {}) as WinningValuesJson;
    const priorInventory =
      (priorWinningValues.inventory as
        | Record<string, Record<string, unknown>>
        | undefined) ?? {};
    const nextInventory: Record<
      string,
      Record<string, InventoryWinnerValue>
    > = {};

    let anyChange = false;
    let leavesWritten = 0;

    for (const [key, bucket] of groups.entries()) {
      const [channelId, locKey] = key.split("\t") as [string, string];

      const observations: PickWinnerObservation[] = bucket.map((row) => ({
        source: row.source,
        sourceRecordId: row.sourceRecordId ?? `${row.source}#unknown`,
        value: {
          source: row.source,
          qty: row.qty,
          clickCollectEligible: row.clickCollectEligible,
          purchaseLimit: row.purchaseLimit,
          backorderAllowed: row.backorderAllowed,
          observedAt: row.observedAt.toISOString()
        } satisfies InventoryWinnerValue,
        confidence: 1,
        observedAt: row.observedAt
      }));

      const winner = pickWinner({
        observations,
        rules,
        channel: channelId,
        attributeCode: "inventory"
      });
      if (winner === null) continue;

      const newValue = winner.value as InventoryWinnerValue;
      const priorValue = priorInventory[channelId]?.[locKey];
      const changed = !deepEqual(priorValue, newValue);

      if (!nextInventory[channelId]) nextInventory[channelId] = {};
      nextInventory[channelId]![locKey] = newValue;

      if (!changed) continue;
      anyChange = true;

      const winningRow = bucket.find(
        (r) =>
          r.source === newValue.source &&
          r.observedAt.toISOString() === newValue.observedAt
      );
      if (!winningRow) {
        throw new Error(
          `reconcileInventory: lost winning row for ${channelId}/${locKey}`
        );
      }

      // For NULL location the DB-generated `location_id_coalesced` resolves
      // it. We insert the original `location_id` (NULL or UUID) and the PK
      // ON CONFLICT clause references the generated column transparently.
      await tx.execute(sql`
        INSERT INTO catalog_inventory_current
          (product_id, channel_id, location_id, qty, source, observed_at)
        VALUES
          (${data.productId}, ${channelId}, ${winningRow.locationId},
           ${winningRow.qty}, ${winningRow.source}, ${winningRow.observedAt})
        ON CONFLICT (product_id, channel_id, location_id_coalesced) DO UPDATE SET
          location_id  = EXCLUDED.location_id,
          qty          = EXCLUDED.qty,
          source       = EXCLUDED.source,
          observed_at  = EXCLUDED.observed_at
      `);
      leavesWritten++;

      await tx.insert(schema.catalogEvents).values({
        eventType: "catalog.product.inventory_changed",
        productId: data.productId,
        tenantId: product.tenantId,
        payload: {
          productId: data.productId,
          channel: channelId,
          location: winningRow.locationId,
          oldValue: priorValue ?? null,
          newValue
        },
        triggeredBy: "reconciler:async"
      });
    }

    if (anyChange) {
      const nextWinningValues: WinningValuesJson = { ...priorWinningValues };
      nextWinningValues.inventory = nextInventory;
      const computedAt = new Date();
      nextWinningValues._meta = {
        reconciler_version: RECONCILER_VERSION,
        rules_version: data.rulesVersion,
        computed_at: computedAt.toISOString()
      };
      await tx
        .update(schema.catalogProducts)
        .set({ winningValues: nextWinningValues, updatedAt: computedAt })
        .where(eq(schema.catalogProducts.productId, data.productId));
    }

    return { winnerChanged: anyChange, leavesWritten };
  });
}
