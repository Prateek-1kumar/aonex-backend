// DLQ promote + replay helpers — plan task 5.5, spec §19.1.
//
// What this provides:
//   * `moveToDlq` — insert a sidecar row into `catalog_events_dlq` for an
//     exhausted event. Idempotent on `event_id` (ON CONFLICT DO NOTHING).
//   * `replayDlq` — re-arm DLQ events for re-publishing by resetting
//     `publish_attempts = 0` (and `published_at = NULL`) on the source
//     `catalog_events` row, then deleting the DLQ sidecar.
//
// CRITICAL design decision — `moveToDlq` does NOT delete the source row:
//
//   Migration 0016 line 11 states verbatim:
//
//     "The original event row is left in catalog_events — DLQ does not
//      delete the source."
//
//   Task 5.3's poller (commit `7bee9ff`) already follows this contract: when
//   the poller hits `publish_attempts >= maxAttempts` it inserts a DLQ row
//   and leaves the `catalog_events` row in place. The claim WHERE clause
//   `publish_attempts < maxAttempts` then naturally excludes the exhausted
//   source row from future polls — no DELETE needed.
//
//   The plan §5.5 task brief says `moveToDlq` should "DELETE from
//   catalog_events". That contradicts the migration comment and Task 5.3's
//   implementation. We resolve in favour of the migration (authoritative for
//   v1) so the audit trail is preserved and the poller / DLQ helper agree.
//
//   Consequence for `replayDlq`: since the source row still exists, replay
//   is "reset publish_attempts on the source row and drop the DLQ sidecar",
//   not "re-insert from the DLQ payload". Option (a) in the task brief.
//
// Poller duplication (known, intentionally not refactored in this task):
//
//   `poller.ts::pollOnce` has its own inline DLQ INSERT (identical shape).
//   The plan §5.5 "What NOT to do" list explicitly forbids refactoring the
//   poller here — that's a follow-up. The two code paths are kept in sync
//   manually for now; a future task can route the poller through
//   `moveToDlq` once a single owner is preferred.

import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { CatalogEvent, DrizzleClient } from "@aonex/db";

const DEFAULT_REPLAY_LIMIT = 1000;

/**
 * No-op pino-compatible logger used when callers don't pass one.
 * Cast through `unknown` because pino's `Logger` is a rich type with
 * `child()`, `level`, EventEmitter members etc.; we only need the
 * level-method shape at runtime. Mirrors `poller.ts::NOOP_LOGGER`.
 */
const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {}
} as unknown as Logger;

// ---------------------------------------------------------------------------
// moveToDlq
// ---------------------------------------------------------------------------

/** Input for `moveToDlq`. */
export interface MoveToDlqInput {
  /** Full event row claimed from `catalog_events`. */
  event: CatalogEvent;
  /** Failure reason surfaced by the publisher (stored verbatim in DLQ). */
  reason: string;
}

/** Dependencies shared by all DLQ helpers. */
export interface MoveToDlqDeps {
  db: DrizzleClient;
  logger?: Logger;
}

/** Result of `moveToDlq`. */
export interface MoveToDlqResult {
  /**
   * `true` when a new DLQ row was inserted; `false` when a row already existed
   * for this `event_id` (ON CONFLICT DO NOTHING).
   *
   * The non-insert case is benign: it means a previous attempt already
   * promoted this event to the DLQ, which is what idempotency guarantees.
   */
  inserted: boolean;
}

/**
 * Insert a DLQ sidecar row for an event that has exhausted its publish
 * attempts. Source `catalog_events` row is intentionally NOT deleted (see
 * file header).
 *
 * Idempotent: re-calling with the same `event.eventId` returns
 * `{inserted: false}` and does not duplicate the DLQ row.
 *
 * The `attempts` column stores the source row's current `publish_attempts`
 * value (i.e. how many times the poller tried to publish before giving up).
 * Callers should pass the already-incremented row — the poller's CTE
 * increments before publish, so by the time we land here the counter is
 * already at maxAttempts.
 */
export async function moveToDlq(
  deps: MoveToDlqDeps,
  input: MoveToDlqInput
): Promise<MoveToDlqResult> {
  const { event, reason } = input;
  const logger = deps.logger ?? NOOP_LOGGER;

  // ON CONFLICT DO NOTHING + RETURNING — if the row existed, the RETURNING
  // clause is empty (Postgres only returns rows that were actually inserted
  // under ON CONFLICT DO NOTHING).
  const result = await deps.db.execute(sql`
    INSERT INTO catalog_events_dlq
      (event_id, original_payload, failure_reason, attempts, failed_at)
    VALUES
      (${Number(event.eventId)},
       ${JSON.stringify(event.payload ?? null)}::jsonb,
       ${reason},
       ${event.publishAttempts},
       now())
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `);

  const inserted = result.rows.length > 0;

  if (inserted) {
    logger.info(
      {
        eventId: Number(event.eventId),
        eventType: event.eventType,
        tenantId: event.tenantId,
        reason,
        attempts: event.publishAttempts
      },
      "catalog.outbox.dlq_promoted"
    );
  } else {
    logger.debug(
      {
        eventId: Number(event.eventId),
        eventType: event.eventType,
        tenantId: event.tenantId
      },
      "catalog.outbox.dlq_already_present"
    );
  }

  return { inserted };
}

// ---------------------------------------------------------------------------
// replayDlq
// ---------------------------------------------------------------------------

/** Options for `replayDlq`. */
export interface ReplayDlqOptions {
  /**
   * Replay only specific event_ids. If omitted (or empty), replay ALL DLQ
   * entries up to `limit`. Ordering is by DLQ `failed_at ASC` so the oldest
   * failures replay first.
   */
  eventIds?: number[];
  /**
   * Cap on rows replayed in this call. Safety guard for ops — a careless
   * `replayDlq()` on a large DLQ should not page everything at once.
   * Default 1000.
   */
  limit?: number;
  /**
   * Dry-run mode: log + count what would be replayed but DO NOT mutate the
   * database. Returns the same shape as a real run, with `dryRun: true`.
   * Default false.
   */
  dryRun?: boolean;
}

/** Result of `replayDlq`. */
export interface ReplayDlqResult {
  /** Number of DLQ rows considered (post-limit, post-eventIds filter). */
  scanned: number;
  /**
   * Number of source `catalog_events` rows successfully re-armed for
   * re-publishing (publish_attempts reset to 0, published_at cleared).
   * In dry-run mode this is the count that WOULD have been replayed.
   */
  replayed: number;
  /**
   * DLQ rows whose source `catalog_events` row no longer exists (e.g. an
   * old partition was detached or dropped). These DLQ rows are LEFT IN
   * PLACE — replay cannot proceed without the source row, and we don't
   * want to silently drop the audit record. Operator decides what to do.
   */
  missingSource: number;
  /** Echo of the `dryRun` option. */
  dryRun: boolean;
}

/**
 * Re-arm DLQ events for re-publishing. For each DLQ row:
 *   1. Look up the source `catalog_events` row by `event_id` (we need its
 *      `occurred_at` to use the partition-pruned composite WHERE).
 *   2. UPDATE the source row: `publish_attempts = 0, published_at = NULL`.
 *   3. DELETE the DLQ row.
 *
 * All three operations for a given event happen in the same transaction.
 * When `eventIds` is not provided we process ALL DLQ rows up to `limit` in
 * a single transaction (low-volume table per spec §19.1).
 *
 * Source-row lookup uses the composite PK `(event_id, occurred_at)` so the
 * UPDATE prunes to a single partition; doing the lookup via a CTE keeps the
 * partition pruning even though the DLQ doesn't store `occurred_at` itself.
 *
 * `missingSource` rows: DLQ rows whose source `catalog_events` row no
 * longer exists. We count them but DO NOT delete the DLQ sidecar — the
 * operator should investigate (probable cause: partition was detached for
 * archival). Returning a count rather than throwing keeps `replayDlq`
 * idempotent for ops.
 *
 * Dry-run: same SELECT runs, counts are computed, but no UPDATE/DELETE is
 * issued. Use for "what would happen?" diagnostics.
 */
export async function replayDlq(
  deps: MoveToDlqDeps,
  options: ReplayDlqOptions = {}
): Promise<ReplayDlqResult> {
  const logger = deps.logger ?? NOOP_LOGGER;
  const limit = options.limit ?? DEFAULT_REPLAY_LIMIT;
  const dryRun = options.dryRun ?? false;
  const eventIds = options.eventIds;

  // Step 1: select DLQ rows to consider. We pull both the DLQ event_id AND
  // the matching source row's occurred_at in one query via LEFT JOIN. This
  // lets us:
  //   * detect missingSource (source row NULL) in a single round-trip
  //   * use the composite PK on UPDATE/DELETE for partition pruning
  //
  // The LEFT JOIN runs against catalog_events, which Postgres prunes via
  // the bigint event_id equality lookup. event_id is indexed via the PK on
  // each partition; a query targeting a small set of event_ids is cheap
  // even at scale.
  //
  // IN-list note: we build the `event_id IN (...)` list by joining bigint
  // literals with `sql.join` rather than passing a JS array — the pg
  // driver does NOT auto-cast a JS array as a Postgres array through
  // tagged-template parameter binding (see catalog-service/merge.ts:806
  // for the canonical comment). For an empty `eventIds`, we fall through
  // to the unfiltered variant.
  const selectQuery =
    eventIds && eventIds.length > 0
      ? sql`
          SELECT
            d.event_id      AS "eventId",
            ce.occurred_at  AS "occurredAt"
          FROM catalog_events_dlq d
          LEFT JOIN catalog_events ce ON ce.event_id = d.event_id
          WHERE d.event_id IN (${sql.join(
            eventIds.map((id) => sql`${id}::bigint`),
            sql`, `
          )})
          ORDER BY d.failed_at ASC
          LIMIT ${limit}
        `
      : sql`
          SELECT
            d.event_id      AS "eventId",
            ce.occurred_at  AS "occurredAt"
          FROM catalog_events_dlq d
          LEFT JOIN catalog_events ce ON ce.event_id = d.event_id
          ORDER BY d.failed_at ASC
          LIMIT ${limit}
        `;

  return deps.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DrizzleClient;

    const scanRes = await tx.execute(selectQuery);
    const scanned = scanRes.rows.length;

    const toReplay: { eventId: number; occurredAt: Date }[] = [];
    let missingSource = 0;

    for (const raw of scanRes.rows as unknown as Array<{
      eventId: string | number;
      occurredAt: Date | string | null;
    }>) {
      if (raw.occurredAt === null) {
        missingSource++;
        continue;
      }
      const occurredAt =
        raw.occurredAt instanceof Date ? raw.occurredAt : new Date(raw.occurredAt);
      toReplay.push({
        eventId: typeof raw.eventId === "string" ? Number(raw.eventId) : raw.eventId,
        occurredAt
      });
    }

    if (dryRun) {
      logger.info(
        {
          scanned,
          replayed: toReplay.length,
          missingSource,
          dryRun: true
        },
        "catalog.outbox.dlq_replay_dry_run"
      );
      return {
        scanned,
        replayed: toReplay.length,
        missingSource,
        dryRun: true
      };
    }

    if (toReplay.length > 0) {
      // Build composite-PK IN-list so Postgres can partition-prune the
      // UPDATE. Mirror the shape used by `poller.ts` for the
      // published_at-mark UPDATE.
      const compositeValues = sql.join(
        toReplay.map(
          (r) =>
            sql`(${r.eventId}::bigint, ${r.occurredAt.toISOString()}::timestamptz)`
        ),
        sql`, `
      );

      await tx.execute(sql`
        UPDATE catalog_events
        SET publish_attempts = 0,
            published_at     = NULL
        WHERE (event_id, occurred_at) IN (${compositeValues})
      `);

      // Delete DLQ sidecars for the replayed events. Same IN-list shape as
      // the SELECT — pg driver doesn't auto-cast JS arrays.
      const replayedIdList = sql.join(
        toReplay.map((r) => sql`${r.eventId}::bigint`),
        sql`, `
      );
      await tx.execute(sql`
        DELETE FROM catalog_events_dlq
        WHERE event_id IN (${replayedIdList})
      `);
    }

    logger.info(
      {
        scanned,
        replayed: toReplay.length,
        missingSource,
        dryRun: false
      },
      "catalog.outbox.dlq_replayed"
    );

    return {
      scanned,
      replayed: toReplay.length,
      missingSource,
      dryRun: false
    };
  });
}
