// Core types for the catalog event outbox poller/publisher pipeline.
// See spec §19 (outbox + DLQ) and Phase 5 plan tasks 5.1-5.5.

/**
 * Row shape from the partitioned `catalog_events` table (migration 0016).
 * Field names are camelCase here; the DB columns are snake_case. The row is
 * inserted by catalog-write (Phase 3) and consumed by the outbox poller.
 *
 * `eventId` is a Postgres BIGSERIAL — represented as bigint in TS to avoid
 * silent precision loss at 2^53.
 */
export interface CatalogEvent {
  eventId: bigint;
  eventType: string;
  productId: string;
  tenantId: string;
  payload: Record<string, unknown>;
  triggeredBy: string | null;
  occurredAt: Date;
  publishedAt: Date | null;
  publishAttempts: number;
}

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
  /** Sleep between empty-claim polls. Default: ~250ms. */
  idleSleepMs?: number;
}
