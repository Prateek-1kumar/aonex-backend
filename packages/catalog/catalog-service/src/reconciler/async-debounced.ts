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
// roots — `enqueueReconcilerJob` takes a caller-owned `Queue` (mirrors the
// `QueueClient` pattern at apps/api/src/queues/client.ts so hot-path callers
// don't pay a Queue construct/close per observation), and `makeReconcilerWorker`
// takes an injected `connection` + `db`. The composition root (apps/worker,
// Phase 4) wires real connections; tests inject test connections.

import { type Queue, Worker, type Job } from "bullmq";
import type IORedis from "ioredis";
import { desc, eq, sql } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import {
  RECONCILER_VERSION,
  pickWinner,
  type PickWinnerObservation
} from "./pick-winner.js";
import { deepEqual, loadActiveRules } from "./_internal.js";

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

/** Failed-job retention for BullMQ `removeOnFail`. Keep the last 1k so an
 *  operator can inspect what blew up; older failures are evicted. */
const RETAINED_FAILED_JOBS = 1_000;

/** Separator used inside in-memory group keys (channelId + locale or
 *  channelId + location). ASCII SOH (U+0001) — illegal in both UUIDs and
 *  channel-code/locale strings, so it can never appear inside a part.
 *  Defined as a constant so producer and consumer cannot drift (TAB worked
 *  but silently breaks under whitespace-normalising tooling). */
const GROUP_KEY_SEP = "";

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
 *  Exported so producers (catalog-write Phase 4) can derive the id without
 *  re-implementing the convention — useful for `Job.getState()` polling and
 *  for tests asserting the dedupe identity.
 *
 *  BullMQ disallows `:` in custom jobIds (reserved for repeatable-job
 *  encoding) so we use a `.` separator to match the queue-name convention. */
export function reconcilerJobId(
  productId: string,
  attributeCode: string
): string {
  return `${productId}.${attributeCode}`;
}

// ---- Enqueue ---------------------------------------------------------------

/**
 * Enqueue a debounced reconcile job onto a caller-supplied Queue. Idempotent —
 * a second enqueue with the same (productId, attributeCode) inside the
 * debounce window does not stack a second job (BullMQ jobId dedupe).
 *
 * The caller owns the `Queue` instance (one per tenant) so we don't pay a
 * BullMQ Queue construct/close per observation on the hot path. This mirrors
 * the `QueueClient` pattern at apps/api/src/queues/client.ts.
 *
 * Throws if the queue name doesn't match the tenant — catches the common bug
 * of passing the wrong tenant's queue (which would silently mis-route).
 *
 * Returns the Job for tests; callers can ignore.
 */
export async function enqueueReconcilerJob(
  queue: Queue,
  opts: EnqueueReconcilerOpts
): Promise<Job> {
  const expectedName = reconcilerQueueName(opts.tenantId);
  if (queue.name !== expectedName) {
    throw new Error(
      `enqueueReconcilerJob: queue "${queue.name}" doesn't match tenant ` +
        `"${opts.tenantId}" (expected "${expectedName}")`
    );
  }
  const data: ReconcilerJobData = {
    tenantId: opts.tenantId,
    productId: opts.productId,
    attributeCode: opts.attributeCode,
    rulesVersion: opts.rulesVersion ?? 1
  };
  return queue.add("reconcile", data, {
    delay: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    jobId: reconcilerJobId(opts.productId, opts.attributeCode),
    removeOnComplete: true,
    removeOnFail: RETAINED_FAILED_JOBS
  });
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

// ---- Shared types ----------------------------------------------------------

interface WinningValuesMeta {
  reconciler_version: string;
  rules_version: number;
  computed_at: string;
}

type WinningValuesJson = Record<string, unknown> & {
  _meta?: WinningValuesMeta;
};

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

    const rules = await loadActiveRules(tx, product.tenantId, ["pricing"]);

    // Group observations by (channelId, locale) → each becomes one
    // `catalog_pricing_current` row + one winning_values leaf.
    const groups = new Map<string, PricingObservationRow[]>();
    for (const row of obsRows) {
      const key = `${row.channelId}${GROUP_KEY_SEP}${row.locale}`;
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
      const [channelId, locale] = key.split(GROUP_KEY_SEP) as [string, string];

      // Track the originating DB row for each PickWinnerObservation we hand
      // to pickWinner. `pickWinner` returns the winning input observation
      // by reference, so we can recover the row without re-deriving identity
      // from (source, observedAt) — which is ambiguous when two observations
      // in the same bucket share both (legal: same connector pass, same ms).
      const obsToRow = new Map<PickWinnerObservation, PricingObservationRow>();
      const observations: PickWinnerObservation[] = bucket.map((row) => {
        const obs: PickWinnerObservation = {
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
        };
        obsToRow.set(obs, row);
        return obs;
      });

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

      // Recover the DB row via pickWinner's reference-equal `observation`.
      const winningRow = obsToRow.get(winner.observation);
      if (!winningRow) {
        // Should be unreachable — pickWinner returns one of `observations`.
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

    const rules = await loadActiveRules(tx, product.tenantId, ["inventory"]);

    // Group by (channelId, location_coalesced). Spec §9.1: NULL location
    // collapses to the sentinel for uniqueness. We use the same sentinel as
    // the winning_values leaf key so reads round-trip cleanly.
    const groups = new Map<string, InventoryObservationRow[]>();
    for (const row of obsRows) {
      const locKey = row.locationId ?? NULL_LOCATION_SENTINEL;
      const key = `${row.channelId}${GROUP_KEY_SEP}${locKey}`;
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
      const [channelId, locKey] = key.split(GROUP_KEY_SEP) as [string, string];

      // See reconcilePricing for the rationale on tracking obs → row by ref.
      const obsToRow = new Map<PickWinnerObservation, InventoryObservationRow>();
      const observations: PickWinnerObservation[] = bucket.map((row) => {
        const obs: PickWinnerObservation = {
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
        };
        obsToRow.set(obs, row);
        return obs;
      });

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

      const winningRow = obsToRow.get(winner.observation);
      if (!winningRow) {
        throw new Error(
          `reconcileInventory: lost winning row for ${channelId}/${locKey}`
        );
      }

      // For NULL location the DB-generated `location_id_coalesced` resolves
      // it. We insert the original `location_id` (NULL or UUID) and the PK
      // ON CONFLICT clause references the generated column transparently.
      //
      // catalog_inventory_current intentionally stores only the hot-path
      // columns (qty + source + observed_at). Extras (clickCollectEligible,
      // purchaseLimit, backorderAllowed) live in
      // winning_values.inventory.<channel>.<loc> per spec §9.1.
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
