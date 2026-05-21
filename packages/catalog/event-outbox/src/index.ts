// @aonex/catalog-event-outbox — turns `catalog_events` rows into published
// events via a multi-worker SKIP LOCKED poller. See spec §19 and the
// Phase 5 plan.

export type { CatalogEvent, Publisher, PollerConfig } from "./types.js";
export { serializeEventForStream } from "./publisher.js";
export { RedisStreamsPublisher } from "./publishers/redis-streams.js";
export type { RedisStreamsPublisherOptions } from "./publishers/redis-streams.js";
export { makePoller } from "./poller.js";
export type {
  Logger,
  PollerOptions,
  PollerStats,
  PollerWorker
} from "./poller.js";
export {
  classifyThrottle,
  DEFAULT_KEY_PREFIX,
  DEFAULT_THRESHOLDS,
  DEFAULT_TTL_SECONDS,
  getCurrentThrottleLevel,
  getCurrentThrottleSignal,
  measureAndPublishBackpressure
} from "./backpressure.js";
export type {
  MeasureBackpressureDeps,
  MeasureBackpressureOptions,
  ThrottleLevel,
  ThrottleSignal,
  ThrottleThresholds
} from "./backpressure.js";
