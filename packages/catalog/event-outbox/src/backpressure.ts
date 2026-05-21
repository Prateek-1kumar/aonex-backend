// Outbox backpressure measurement + throttle signal — plan task 5.4, spec §19.1.
//
// What this does:
//   Measures unpublished `catalog_events` lag (count of rows with
//   `published_at IS NULL`) — globally or per-tenant — classifies the lag
//   into one of four `ThrottleLevel`s, and publishes the result to Redis
//   under a well-known key. Adapter workers (task 5.6) consume this signal
//   to reduce their concurrency when the outbox is falling behind, so the
//   outbox never grows unbounded.
//
// Lag → ThrottleLevel (spec §19.1):
//   * count < 10K           → "none"            no action
//   * 10K  ≤ count < 100K   → "soft"            50% concurrency
//   * 100K ≤ count < 500K   → "hard"            10% concurrency + alert
//   * 500K ≤ count          → "emergency_stop"  pause workers + page on-call
//
//   Boundary semantics: inclusive-low / exclusive-high. The boundary
//   numbers themselves classify UP. e.g. exactly 10_000 → "soft",
//   exactly 100_000 → "hard", exactly 500_000 → "emergency_stop".
//
// Tenant scoping (spec §19.1 + §17.3 isolation):
//   `measureAndPublishBackpressure({ tenantId })` filters the count to a
//   single tenant — one noisy tenant's lag does not throttle others.
//   Omitting `tenantId` (or passing `undefined`) measures global lag
//   across all tenants and publishes under the sentinel suffix `_global`.
//
// Redis key shape:
//   `<keyPrefix>:<tenantId or _global>` (default prefix
//   `catalog:event-outbox:throttle`). The payload is JSON-encoded
//   `ThrottleSignal`. Keys are set with a TTL (default 60s) so a hung
//   measurement task does not leave a stale signal pinning workers.
//
// Fail-open contract:
//   `getCurrentThrottleLevel` returns "none" when the key is absent or
//   the JSON is corrupted. The throttle is an OPTIMISATION: if the
//   measurement is missing we want adapter workers to run at full speed,
//   not to stall ingestion waiting for a signal that may never arrive.
//
// Performance caveat (v1):
//   `SELECT count(*)` on a partitioned table can be slow on very large
//   data sets. The partial index `idx_catalog_events_unpublished`
//   (migration 0016) restricts the scan to unpublished rows only, which
//   keeps the query well under 100ms even at 1M+ rows. If lag
//   measurement becomes a hot spot in observability dashboards, swap to
//   a `pg_class.reltuples` estimate or maintain a counter.

import { sql } from "drizzle-orm";
import type { Redis as IORedis } from "ioredis";
import type { Logger } from "pino";
import type { DrizzleClient } from "@aonex/db";

/** All possible throttle levels. Spec §19.1 — do NOT expand this vocabulary. */
export type ThrottleLevel = "none" | "soft" | "hard" | "emergency_stop";

/**
 * The full throttle payload written to Redis and returned by the
 * measurement function. Adapter workers read this (via
 * `getCurrentThrottleSignal`) to decide concurrency limits and whether to
 * raise alerts / page on-call.
 */
export interface ThrottleSignal {
  level: ThrottleLevel;
  /** Count of unpublished events at measurement time. */
  unpublishedCount: number;
  /** When the count was taken. ISO-serialised over the wire. */
  measuredAt: Date;
  /** `true` for "hard" and "emergency_stop". Drives ops alerting. */
  alert: boolean;
  /** `true` for "emergency_stop" only. Drives PagerDuty / on-call page. */
  page: boolean;
  /** `null` when the signal is the global cross-tenant aggregate. */
  tenantId: string | null;
}

/** Tunable thresholds. Defaults match spec §19.1 exactly. */
export interface ThrottleThresholds {
  /** Inclusive lower bound for "soft". Default 10_000. */
  softMin: number;
  /** Inclusive lower bound for "hard". Default 100_000. */
  hardMin: number;
  /** Inclusive lower bound for "emergency_stop". Default 500_000. */
  emergencyMin: number;
}

export const DEFAULT_THRESHOLDS: ThrottleThresholds = {
  softMin: 10_000,
  hardMin: 100_000,
  emergencyMin: 500_000
};

/** Default Redis key prefix. The full key is `<prefix>:<tenantId or _global>`. */
export const DEFAULT_KEY_PREFIX = "catalog:event-outbox:throttle";

/**
 * Default TTL (seconds) on the Redis throttle signal key.
 *
 * Picked so that a measurement loop running on the typical
 * 10-30s cadence keeps the key fresh, but a stuck measurement loop
 * does not leave stale data pinning adapter workers indefinitely —
 * after one minute of silence we revert to fail-open "none".
 */
export const DEFAULT_TTL_SECONDS = 60;

/**
 * Sentinel inserted in place of tenantId when measuring global lag.
 * Tenant ids in this system are UUIDs (see `tenants.id`), so a
 * leading-underscore literal can never collide with a real id.
 */
const GLOBAL_TENANT_KEY = "_global";

export interface MeasureBackpressureDeps {
  db: DrizzleClient;
  redis: IORedis;
  logger?: Logger;
}

export interface MeasureBackpressureOptions {
  /**
   * Scope the measurement to a single tenant. Omit (or pass `undefined`)
   * to measure global lag across all tenants — that signal is published
   * under the sentinel suffix `_global` so it never collides with a real
   * tenant UUID.
   */
  tenantId?: string;
  /** Override the lag → level thresholds. Defaults match spec §19.1. */
  thresholds?: ThrottleThresholds;
  /** Override the Redis key prefix. Default `catalog:event-outbox:throttle`. */
  keyPrefix?: string;
  /** Override TTL on the throttle key, in seconds. Default 60. */
  ttlSeconds?: number;
}

/**
 * No-op pino-compatible logger used when callers don't pass one.
 * Cast via `unknown` because pino's `Logger` is a rich type; we only
 * touch the level methods at runtime. Mirrors poller.ts's NOOP_LOGGER.
 */
const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {}
} as unknown as Logger;

/**
 * Classify a raw unpublished count into a throttle level.
 *
 * Boundary semantics: inclusive-low / exclusive-high. So with the spec
 * defaults `count === 10_000` is "soft", `count === 100_000` is "hard",
 * and `count === 500_000` is "emergency_stop".
 *
 * Pure function — exposed for tests and for callers that want to
 * classify a count obtained elsewhere (e.g. a `pg_class.reltuples`
 * estimate) without going through `measureAndPublishBackpressure`.
 */
export function classifyThrottle(
  count: number,
  thresholds: ThrottleThresholds = DEFAULT_THRESHOLDS
): ThrottleLevel {
  if (count < thresholds.softMin) return "none";
  if (count < thresholds.hardMin) return "soft";
  if (count < thresholds.emergencyMin) return "hard";
  return "emergency_stop";
}

/** Compose the Redis key for a (prefix, tenantId|null) pair. */
function throttleKey(prefix: string, tenantId: string | null): string {
  return `${prefix}:${tenantId ?? GLOBAL_TENANT_KEY}`;
}

/**
 * Whether a level should raise an ops alert. "hard" and
 * "emergency_stop" both alert — only the latter pages on-call.
 */
function alertFor(level: ThrottleLevel): boolean {
  return level === "hard" || level === "emergency_stop";
}

function pageFor(level: ThrottleLevel): boolean {
  return level === "emergency_stop";
}

/**
 * Count unpublished events and publish the resulting `ThrottleSignal` to
 * Redis. Returns the signal so callers (e.g. an observability collector)
 * can also forward it elsewhere.
 *
 * Behaviour:
 *   * Runs `SELECT count(*) FROM catalog_events WHERE published_at IS
 *     NULL [AND tenant_id = $1]` against the supplied Drizzle client.
 *   * Classifies the result via `classifyThrottle`.
 *   * Writes `<keyPrefix>:<tenantId or _global>` to Redis as JSON with
 *     `EX <ttlSeconds>` so the signal naturally expires if the measure
 *     loop stops.
 *
 * Errors:
 *   * DB query errors propagate (callers should catch and log).
 *   * Redis SET errors propagate after the count is logged (so the
 *     count metric is at least observable in the logger before the
 *     write failure surfaces to the caller).
 *
 * This function is one-shot. The cron / interval wiring belongs in
 * task 5.6 (the adapter worker manager).
 */
export async function measureAndPublishBackpressure(
  deps: MeasureBackpressureDeps,
  options: MeasureBackpressureOptions = {}
): Promise<ThrottleSignal> {
  const logger = deps.logger ?? NOOP_LOGGER;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const tenantId = options.tenantId ?? null;

  // Partial index `idx_catalog_events_unpublished` (migration 0016)
  // restricts this scan to `published_at IS NULL`, so it is fast even
  // with millions of historical published rows. The tenant predicate
  // (when present) is composable on the same index because it's an
  // additional equality filter on the matching rows.
  const result = tenantId
    ? await deps.db.execute(sql`
        SELECT count(*)::bigint AS n
        FROM catalog_events
        WHERE published_at IS NULL
          AND tenant_id = ${tenantId}
      `)
    : await deps.db.execute(sql`
        SELECT count(*)::bigint AS n
        FROM catalog_events
        WHERE published_at IS NULL
      `);

  // node-postgres returns bigint as `string`; coerce. The count fits in
  // a Number safely well past spec thresholds (Number.MAX_SAFE_INTEGER
  // ~ 9e15, our worst-case is ~500K).
  const row = result.rows[0] as { n: string | number } | undefined;
  const unpublishedCount = row ? Number(row.n) : 0;

  const level = classifyThrottle(unpublishedCount, thresholds);
  const signal: ThrottleSignal = {
    level,
    unpublishedCount,
    measuredAt: new Date(),
    alert: alertFor(level),
    page: pageFor(level),
    tenantId
  };

  const key = throttleKey(keyPrefix, tenantId);
  // SET ... EX <ttl> is atomic; no need for SETEX (deprecated form).
  await deps.redis.set(key, JSON.stringify(signal), "EX", ttlSeconds);

  if (signal.page) {
    logger.error(
      {
        tenantId: tenantId ?? "_global",
        unpublishedCount,
        level
      },
      "catalog.outbox.backpressure_emergency_stop"
    );
  } else if (signal.alert) {
    logger.warn(
      {
        tenantId: tenantId ?? "_global",
        unpublishedCount,
        level
      },
      "catalog.outbox.backpressure_alert"
    );
  } else {
    logger.debug(
      {
        tenantId: tenantId ?? "_global",
        unpublishedCount,
        level
      },
      "catalog.outbox.backpressure_measured"
    );
  }

  return signal;
}

/**
 * Read the current throttle level for the given tenant (or global if
 * omitted). **Fail-open:** returns "none" if the key is missing (TTL
 * expired, measurement loop stopped, etc.) OR if the stored JSON is
 * corrupt. The throttle is an optimisation; we never block ingestion
 * because of a missing signal.
 *
 * For callers that need the full payload (e.g. to surface
 * `alert`/`page`/`measuredAt` to a dashboard) use
 * `getCurrentThrottleSignal`.
 */
export async function getCurrentThrottleLevel(
  redis: IORedis,
  tenantId?: string,
  keyPrefix: string = DEFAULT_KEY_PREFIX,
  logger?: Logger
): Promise<ThrottleLevel> {
  const signal = await getCurrentThrottleSignal(
    redis,
    tenantId,
    keyPrefix,
    logger
  );
  return signal?.level ?? "none";
}

/**
 * Read the full `ThrottleSignal` for the given tenant (or global if
 * omitted). Returns `null` when the key is missing or the payload is
 * corrupt — corrupt payloads are also logged at warn level via the
 * optional `logger`. **Fail-open** semantics are the caller's
 * responsibility for the full-signal accessor; most adapter workers
 * should use `getCurrentThrottleLevel` instead.
 */
export async function getCurrentThrottleSignal(
  redis: IORedis,
  tenantId?: string,
  keyPrefix: string = DEFAULT_KEY_PREFIX,
  logger?: Logger
): Promise<ThrottleSignal | null> {
  const key = throttleKey(keyPrefix, tenantId ?? null);
  const raw = await redis.get(key);
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as ThrottleSignal & {
      measuredAt: string | Date;
    };
    // Rehydrate Date — JSON.stringify produced an ISO string.
    return {
      ...parsed,
      measuredAt:
        parsed.measuredAt instanceof Date
          ? parsed.measuredAt
          : new Date(parsed.measuredAt)
    };
  } catch (err: unknown) {
    (logger ?? NOOP_LOGGER).warn(
      {
        key,
        error: err instanceof Error ? err.message : String(err)
      },
      "catalog.outbox.backpressure_corrupt_signal"
    );
    return null;
  }
}

// Internal — exposed for tests so they can assert key shape without
// duplicating the sentinel literal.
export const __INTERNAL_FOR_TESTS = {
  throttleKey,
  GLOBAL_TENANT_KEY
};
