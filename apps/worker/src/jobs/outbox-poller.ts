// Outbox poller spawner — plan task §5.6, spec §19.1.
//
// Spawns the multi-worker outbox poller (`@aonex/catalog-event-outbox` —
// `makePoller`) at boot alongside a 10-second backpressure measurement
// interval.
//
// Lifecycle:
//   - Called from `buildContainer` (apps/worker/src/composition-root.ts).
//   - Returns an `OutboxHandle` that the container stashes; on `stop()` the
//     container invokes `handle.stop()` which clears the interval and stops
//     each PollerWorker loop in parallel.
//
// Backpressure cadence — design notes:
//   - 10s interval matches spec §19.1 / task 5.4 sizing (TTL = 60s, so a
//     10s tick gives 6x headroom for transient stalls before the key
//     fails-open to "none").
//   - We KICK ONCE IMMEDIATELY on start so a fresh boot has a signal in
//     Redis before the first interval fires. Without the immediate kick
//     adapter workers (Phase 5.6+ consumers) would see "no key → fail
//     open to none" for the first 10s after every restart — a small
//     window, but one we can close cheaply.
//   - Per-tenant measurement is deferred. v1 publishes only the global
//     cross-tenant aggregate (the `_global` sentinel suffix).

import IORedis from "ioredis";
import type { Logger } from "pino";
import type { DrizzleClient } from "@aonex/db";
import {
  makePoller,
  measureAndPublishBackpressure,
  RedisStreamsPublisher,
  type PollerWorker,
  type Publisher
} from "@aonex/catalog-event-outbox";

const DEFAULT_WORKER_COUNT = 4;
const DEFAULT_STREAM_NAME = "catalog.events";
const DEFAULT_BACKPRESSURE_INTERVAL_MS = 10_000;

export interface StartOutboxDeps {
  db: DrizzleClient;
  connection: IORedis;
  logger?: Logger;
}

export interface StartOutboxOptions {
  /** Number of poller workers. Default 4 (spec §19.1). */
  workerCount?: number;
  /** Redis Stream name for published events. Default `catalog.events`. */
  streamName?: string;
  /** Cadence for backpressure measurement, in ms. Default 10_000. */
  backpressureIntervalMs?: number;
  /**
   * Optional override for the Publisher. Primarily for tests that want
   * to inject a mock without touching Redis. When omitted (production
   * path), `RedisStreamsPublisher` is constructed against `connection`
   * and `streamName`.
   */
  publisher?: Publisher;
}

export interface OutboxHandle {
  workers: PollerWorker[];
  stop(): Promise<void>;
}

/**
 * Boot the outbox poller workers + backpressure measurement interval.
 *
 * Returns a handle the caller must `stop()` on graceful shutdown.
 *
 * Error handling:
 *   - Backpressure tick failures are logged and swallowed; a single DB
 *     blip should not crash the interval. The measurement is an
 *     OPTIMISATION (fail-open semantics on the consumer side — see
 *     `getCurrentThrottleLevel`), so a missed tick is recoverable.
 *   - Poller-loop errors are handled inside `makePoller` (top-level
 *     try/catch in `runLoop`) and do not bubble up here.
 */
export async function startOutboxPoller(
  deps: StartOutboxDeps,
  options: StartOutboxOptions = {}
): Promise<OutboxHandle> {
  const { db, connection, logger } = deps;

  const workerCount = options.workerCount ?? DEFAULT_WORKER_COUNT;
  const streamName = options.streamName ?? DEFAULT_STREAM_NAME;
  const backpressureIntervalMs =
    options.backpressureIntervalMs ?? DEFAULT_BACKPRESSURE_INTERVAL_MS;

  // The publisher does NOT own the connection — the composition root does.
  // Tests can inject a Publisher via `options.publisher` to avoid touching
  // Redis.
  const publisher: Publisher =
    options.publisher ??
    new RedisStreamsPublisher({ redis: connection, streamName });

  // Build the workers (NOT started yet). `makePoller` returns N handles.
  // Spread `logger` only when supplied — passing `undefined` explicitly
  // would trip `exactOptionalPropertyTypes` on the downstream type.
  const workers = makePoller({
    db,
    publisher,
    workerCount,
    ...(logger !== undefined ? { logger } : {})
  });
  for (const w of workers) w.start();
  logger?.info(
    { workerCount, streamName },
    "Outbox poller workers started"
  );

  // Backpressure measurement interval. Global (cross-tenant) measurement
  // only in v1; per-tenant measurement is deferred (spec §17.3 isolation
  // doesn't require it for the global throttle path).
  let stopped = false;
  const backpressureTick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await measureAndPublishBackpressure({
        db,
        redis: connection,
        ...(logger !== undefined ? { logger } : {})
      });
    } catch (err) {
      logger?.error(
        { err: err instanceof Error ? err.message : String(err) },
        "outbox.backpressure.tick_failed"
      );
    }
  };
  // Immediate kick so a fresh boot has a signal in Redis before the first
  // interval fires (avoids a 10s "no key → fail-open none" window after
  // restart). `void` because we don't want to block start-up on this.
  void backpressureTick();
  const intervalHandle = setInterval(
    () => void backpressureTick(),
    backpressureIntervalMs
  );

  return {
    workers,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(intervalHandle);
      await Promise.all(workers.map((w) => w.stop()));
      logger?.info("Outbox poller workers stopped");
    }
  };
}
