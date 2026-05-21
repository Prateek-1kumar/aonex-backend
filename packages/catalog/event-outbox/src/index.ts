// @aonex/catalog-event-outbox — turns `catalog_events` rows into published
// events via a multi-worker SKIP LOCKED poller. The poller lands in task
// 5.3; this barrel re-exports the Phase 5.2 Publisher surface. See spec
// §19 and the Phase 5 plan.

export type { CatalogEvent, Publisher, PollerConfig } from "./types.js";
export { serializeEventForStream } from "./publisher.js";
export { RedisStreamsPublisher } from "./publishers/redis-streams.js";
export type { RedisStreamsPublisherOptions } from "./publishers/redis-streams.js";
