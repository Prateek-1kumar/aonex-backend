// Core types for the catalog event outbox poller/publisher pipeline.
// See spec §19 (outbox + DLQ) and Phase 5 plan tasks 5.1-5.5.
//
// `CatalogEvent` is re-exported from `@aonex/db` so this package shares the
// canonical row shape inferred from the Drizzle schema in
// `packages/db/src/schema/catalog-events.ts`.

export type { CatalogEvent } from "@aonex/db";

import type { CatalogEvent } from "@aonex/db";

/**
 * Sink the poller hands claimed events to. Implementations are responsible
 * for delivering events to their target (Redis stream, Kafka, in-memory test
 * harness, etc.) and reporting per-event success/failure so the poller can
 * mark `published_at` or increment `publish_attempts` / route to DLQ.
 */
export interface Publisher {
  publish(events: CatalogEvent[]): Promise<{
    published: number;
    failed: { event: CatalogEvent; reason: string }[];
  }>;
}

/**
 * Poller tuning knobs. All fields optional with sensible defaults applied by
 * the poller in Task 5.3. Defaults below reflect spec §19.1.
 */
export interface PollerConfig {
  /** Rows claimed per `FOR UPDATE SKIP LOCKED` batch. Default: 100. */
  batchSize?: number;
  /** Concurrent worker loops sharing the same poller. Default: 4. */
  workerCount?: number;
  /** Promote to DLQ once `publish_attempts` reaches this. Default: 5. */
  maxAttempts?: number;
  /** Sleep between empty-claim polls. Default: 250ms. */
  idleSleepMs?: number;
}
