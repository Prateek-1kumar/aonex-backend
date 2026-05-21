// Multi-worker outbox poller — plan task 5.3, spec §19.1.
//
// Drains the `catalog_events` table by claiming unpublished rows with
// `FOR UPDATE SKIP LOCKED`, handing the batch to a `Publisher`, and recording
// success/failure back into the table (or routing exhausted rows to the
// `catalog_events_dlq` sidecar).
//
// Worker model:
//   A "PollerWorker" here is NOT a BullMQ Worker. It is a long-running async
//   loop wrapped in a handle object. `makePoller()` returns N handles; the
//   caller invokes `worker.start()` / `worker.stop()` to control lifecycle
//   (matching the BullMQ Worker convention used elsewhere in the repo).
//
// Transaction boundary (CRITICAL):
//   Claim + publish + mark-published-or-DLQ all happen inside one transaction
//   per poll cycle. We hold the row-level FOR UPDATE locks through publish so
//   a second worker cannot re-claim mid-publish. If the worker crashes
//   between claim and publish, the transaction aborts and the publish_attempts
//   increment from the CTE-then-UPDATE is rolled back — the rows become
//   reclaimable on the next cycle. Spec §19.1 documents this contract.
//
//   Idle-in-transaction timeout: as long as Publisher.publish() completes in
//   well under Postgres `idle_in_transaction_session_timeout` (typical 30s+),
//   the default batchSize of 100 is comfortable. Redis Streams publishes are
//   sub-ms each. If a slower backend is plugged in, lower batchSize.
//
// publish_attempts semantics:
//   The CTE-then-UPDATE increments `publish_attempts` AT CLAIM TIME, before
//   publish. A worker crash mid-publish therefore leaves the counter
//   incremented — that is spec-correct: the counter records *attempts*, not
//   *publish errors*. After `maxAttempts` (default 5) attempts the claim
//   WHERE clause naturally excludes the row from future claims, and the DLQ
//   path below inserts a sidecar record for operator visibility.
//
// DLQ semantics — source row is RETAINED:
//   Migration 0016 line 11 states: "The original event row is left in
//   catalog_events — DLQ does not delete the source." We follow the
//   migration's stated intent. The claim WHERE `publish_attempts < 5`
//   naturally excludes exhausted rows from future claims, so a DLQ-only
//   sidecar insert is sufficient. (Plan §5.5 contemplates revisiting this,
//   but the migration is canonical for v1.)
//
// Idempotency:
//   `Publisher.publish` is responsible for per-event-id idempotency
//   (RedisStreamsPublisher does this via a Lua SET-NX claim — see
//   publishers/redis-streams.ts). The poller does NOT add a second layer; it
//   trusts the publisher's `published` count and `failed[]` per-event reports.

import { sql, type SQL } from "drizzle-orm";
import type { CatalogEvent, DrizzleClient } from "@aonex/db";
import type { PollerConfig, Publisher } from "./types.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_WORKER_COUNT = 4;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_IDLE_SLEEP_MS = 250;

/** Minimal logger contract — accepts an optional bag of structured fields. */
export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

export interface PollerOptions extends PollerConfig {
  db: DrizzleClient;
  publisher: Publisher;
  logger?: Logger;
}

/** Snapshot of counters maintained per worker for observability + tests. */
export interface PollerStats {
  /** Rows claimed across all polls (post-CTE UPDATE, so == attempts billed). */
  claimed: number;
  /** Rows the publisher reported `published`. */
  processed: number;
  /** Rows the publisher reported `failed[]`. Includes rows that later DLQd. */
  failed: number;
  /** Rows inserted into catalog_events_dlq this worker's lifetime. */
  dlqd: number;
  /** Loop iterations that returned 0 claimed rows. */
  emptyPolls: number;
}

/**
 * Handle to a single poller loop. Named `PollerWorker` to disambiguate from
 * BullMQ's `Worker` (which is also used in this repo — see catalog-service).
 *
 * Lifecycle:
 *   * Construction (`makePoller`) does NOT auto-start the loop.
 *   * `start()` is idempotent — calling it on an already-running worker
 *     returns the in-flight promise.
 *   * `stop()` flips the running flag and resolves when the current poll
 *     cycle completes (i.e. the in-flight transaction commits/rolls back).
 *     Calling `stop()` on an already-stopped worker resolves immediately.
 *   * `stats()` returns a snapshot at the moment of call.
 */
export interface PollerWorker {
  readonly id: number;
  start(): void;
  stop(): Promise<void>;
  stats(): PollerStats;
}

/**
 * Construct N worker handles sharing one DB + publisher. Workers are
 * independent — they coordinate at the DB level via `FOR UPDATE SKIP LOCKED`.
 *
 * Defaults match spec §19.1: batchSize=100, workerCount=4, maxAttempts=5,
 * idleSleepMs=250.
 */
export function makePoller(opts: PollerOptions): PollerWorker[] {
  const workerCount = opts.workerCount ?? DEFAULT_WORKER_COUNT;
  const workers: PollerWorker[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(makePollerWorker(i, opts));
  }
  return workers;
}

interface InternalState {
  running: boolean;
  loop: Promise<void> | null;
}

/**
 * Build one PollerWorker handle. Exported only via `makePoller` — the per-worker
 * factory is internal so the public API forces callers to think about
 * `workerCount` (and avoids the foot-gun of starting overlapping loops on the
 * same logical worker id).
 */
function makePollerWorker(id: number, opts: PollerOptions): PollerWorker {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const idleSleepMs = opts.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;
  const logger = opts.logger ?? NOOP_LOGGER;

  const stats: PollerStats = {
    claimed: 0,
    processed: 0,
    failed: 0,
    dlqd: 0,
    emptyPolls: 0
  };

  const state: InternalState = { running: false, loop: null };

  async function runLoop(): Promise<void> {
    while (state.running) {
      let claimedCount = 0;
      try {
        claimedCount = await pollOnce({
          db: opts.db,
          publisher: opts.publisher,
          batchSize,
          maxAttempts,
          stats,
          logger,
          workerId: id
        });
      } catch (err: unknown) {
        // Top-level guard: a thrown error inside the transaction rolls it
        // back (Drizzle re-throws). Log + back off so a transient DB blip
        // doesn't spin-lock the loop. Spec leaves error policy implicit; we
        // treat it as an idle cycle.
        logger.error("poller.cycle_failed", {
          workerId: id,
          error: err instanceof Error ? err.message : String(err)
        });
        claimedCount = 0;
      }
      if (claimedCount === 0) {
        stats.emptyPolls++;
        if (!state.running) break;
        await sleep(idleSleepMs);
      } else if (claimedCount < batchSize) {
        // Less-than-full batch: brief breather to avoid hammering when the
        // queue is mostly drained but not empty. A full batch loops
        // immediately so a backlog drains as fast as possible.
        if (!state.running) break;
        await sleep(Math.min(idleSleepMs, 50));
      }
      // Full batch → loop immediately (no sleep).
    }
  }

  return {
    id,
    start(): void {
      if (state.running) return;
      state.running = true;
      state.loop = runLoop();
    },
    async stop(): Promise<void> {
      if (!state.running && state.loop === null) return;
      state.running = false;
      const loop = state.loop;
      state.loop = null;
      if (loop) await loop;
    },
    stats(): PollerStats {
      // Defensive copy so callers can't mutate internal counters.
      return { ...stats };
    }
  };
}

interface PollOnceDeps {
  db: DrizzleClient;
  publisher: Publisher;
  batchSize: number;
  maxAttempts: number;
  stats: PollerStats;
  logger: Logger;
  workerId: number;
}

/**
 * One poll cycle: claim → publish → mark-or-DLQ, all in one transaction.
 * Returns the number of rows claimed (== rows for which publish_attempts was
 * incremented). 0 means the loop should sleep before retrying.
 */
async function pollOnce(deps: PollOnceDeps): Promise<number> {
  const { db, publisher, batchSize, maxAttempts, stats, logger, workerId } = deps;

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DrizzleClient;

    // Canonical claim query — spec §19.1. CTE-then-UPDATE keeps the FOR UPDATE
    // SKIP LOCKED on the unfiltered scan while incrementing publish_attempts
    // atomically. RETURNING * gives us post-update rows so the new
    // publish_attempts value is what the DLQ-threshold check below sees.
    //
    // event_id alone is sufficient in the UPDATE WHERE because BIGSERIAL is
    // globally unique across partitions — even though the PK is composite
    // (event_id, occurred_at). The planner uses the partition-pruned PK
    // index efficiently for this lookup (confirmed empirically — see the
    // partition index check in catalog-events.test.ts).
    const claimedRes = await tx.execute(sql`
      WITH claimed AS (
        SELECT event_id, occurred_at
        FROM catalog_events
        WHERE published_at IS NULL
          AND publish_attempts < ${maxAttempts}
        ORDER BY occurred_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE catalog_events
      SET publish_attempts = publish_attempts + 1
      WHERE (event_id, occurred_at) IN (SELECT event_id, occurred_at FROM claimed)
      RETURNING
        event_id        AS "eventId",
        event_type      AS "eventType",
        product_id      AS "productId",
        tenant_id       AS "tenantId",
        payload,
        triggered_by    AS "triggeredBy",
        occurred_at     AS "occurredAt",
        published_at    AS "publishedAt",
        publish_attempts AS "publishAttempts"
    `);

    const rows = (claimedRes.rows as unknown as RawClaimedRow[]).map(normalizeRow);
    if (rows.length === 0) {
      return 0;
    }
    stats.claimed += rows.length;

    const publishRes = await publisher.publish(rows);
    stats.processed += publishRes.published;
    stats.failed += publishRes.failed.length;

    // Build the failed-id set so we can compute the success set by subtraction.
    const failedMap = new Map<string, string>();
    for (const f of publishRes.failed) {
      failedMap.set(String(f.event.eventId), f.reason);
    }

    // Mark successes: published_at = now() for every claimed row not in failed.
    // We treat publisher.publish's contract as "events not in `failed` and
    // counted in published OR silently deduplicated" — either way the row is
    // safe to mark `published_at` because no further attempts are warranted.
    const successIds: number[] = [];
    for (const row of rows) {
      if (!failedMap.has(String(row.eventId))) {
        successIds.push(Number(row.eventId));
      }
    }
    if (successIds.length > 0) {
      // event_id IN (...) is sufficient (see note above about BIGSERIAL global
      // uniqueness). One UPDATE per cycle — batches into a single round-trip.
      const placeholders = sql.join(
        successIds.map((id) => sql`${id}`),
        sql`, `
      );
      await tx.execute(sql`
        UPDATE catalog_events
        SET published_at = now()
        WHERE event_id IN (${placeholders})
      `);
    }

    // Handle failures: if post-increment publish_attempts >= maxAttempts, the
    // event is exhausted — insert a DLQ sidecar. We do NOT delete the source
    // row (see migration 0016 line 11 + file header). The claim WHERE clause
    // naturally excludes exhausted rows from future claims.
    //
    // ON CONFLICT DO NOTHING on catalog_events_dlq.event_id makes the DLQ
    // insert idempotent — a re-run after a crash between DLQ-insert and tx
    // commit won't double-insert.
    let dlqdThisCycle = 0;
    for (const failure of publishRes.failed) {
      const row = rows.find((r) => String(r.eventId) === String(failure.event.eventId));
      if (!row) continue;
      if (row.publishAttempts >= maxAttempts) {
        await tx.execute(sql`
          INSERT INTO catalog_events_dlq
            (event_id, original_payload, failure_reason, attempts, failed_at)
          VALUES
            (${Number(row.eventId)},
             ${JSON.stringify(row.payload ?? null)}::jsonb,
             ${failure.reason},
             ${row.publishAttempts},
             now())
          ON CONFLICT (event_id) DO NOTHING
        `);
        dlqdThisCycle++;
      }
    }
    stats.dlqd += dlqdThisCycle;

    if (publishRes.failed.length > 0 || dlqdThisCycle > 0) {
      logger.warn("poller.cycle_partial", {
        workerId,
        claimed: rows.length,
        published: publishRes.published,
        failed: publishRes.failed.length,
        dlqd: dlqdThisCycle
      });
    } else {
      logger.info("poller.cycle_ok", {
        workerId,
        claimed: rows.length,
        published: publishRes.published
      });
    }

    return rows.length;
  });
}

/**
 * Raw shape returned by the CTE-then-UPDATE. node-postgres returns timestamps
 * as `Date`, jsonb as parsed JSON, and bigint as `string` (because the column
 * type is BIGSERIAL). We normalise to the `CatalogEvent` Drizzle type which
 * uses `number` for eventId (BIGSERIAL bigint mode "number" in the schema).
 *
 * We intentionally avoid Drizzle's query builder here because the CTE+UPDATE
 * pattern with composite-PK IN isn't directly expressible without dropping to
 * raw SQL anyway. Using `tx.execute(sql`...`)` keeps the wire shape explicit.
 */
interface RawClaimedRow {
  eventId: string | number;
  eventType: string;
  productId: string;
  tenantId: string;
  payload: unknown;
  triggeredBy: string | null;
  occurredAt: Date | string;
  publishedAt: Date | string | null;
  publishAttempts: number;
}

function normalizeRow(raw: RawClaimedRow): CatalogEvent {
  const occurredAt =
    raw.occurredAt instanceof Date ? raw.occurredAt : new Date(raw.occurredAt);
  const publishedAt =
    raw.publishedAt === null
      ? null
      : raw.publishedAt instanceof Date
        ? raw.publishedAt
        : new Date(raw.publishedAt);
  return {
    eventId: typeof raw.eventId === "string" ? Number(raw.eventId) : raw.eventId,
    eventType: raw.eventType,
    productId: raw.productId,
    tenantId: raw.tenantId,
    payload: raw.payload,
    triggeredBy: raw.triggeredBy,
    occurredAt,
    publishedAt,
    publishAttempts: raw.publishAttempts
  } as CatalogEvent;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export the SQL type for downstream test files that want to spy on
// constructed queries. Internal; not part of the public barrel.
export type { SQL };
