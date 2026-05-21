// @aonex/catalog-event-outbox — turns `catalog_events` rows into published
// events via a multi-worker SKIP LOCKED poller. Phase 5 scaffold; publisher
// + poller land in tasks 5.2 / 5.3. See spec §19 and the Phase 5 plan.

export type { CatalogEvent, Publisher, PollerConfig } from "./types.js";
