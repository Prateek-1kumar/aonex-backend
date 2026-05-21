// Publisher contract + shared helpers used by every publisher backend.
//
// The `Publisher` interface itself lives in `./types.ts` (single source of
// truth — re-exported here for convenience so concrete impls can import
// everything they need from one file). This module also exposes the field
// serialization used by stream-style publishers (Redis Streams, Kafka, etc.)
// to keep the wire format consistent across backends.
//
// See Phase 5 plan task 5.2 and spec §19.

import type { CatalogEvent } from "./types.js";

export type { Publisher } from "./types.js";

/**
 * Serialize a CatalogEvent into the flat `field, value, field, value, ...`
 * shape stream backends expect.
 *
 * Conventions (locked for v1 — bump a version field if this changes):
 *   - `eventId`         : decimal string of the BIGSERIAL primary key
 *   - `eventType`       : raw string (e.g. `catalog.product.pricing_changed`)
 *   - `productId`       : UUID string
 *   - `tenantId`        : UUID string
 *   - `payload`         : JSON-stringified `event.payload`
 *   - `triggeredBy`     : raw string; **empty string** when null on the row
 *   - `occurredAt`      : ISO-8601 UTC string
 *   - `publishAttempts` : decimal string
 *
 * Consumers MUST treat `triggeredBy === ""` as "no triggering actor".
 */
export function serializeEventForStream(event: CatalogEvent): Record<string, string> {
  return {
    eventId: String(event.eventId),
    eventType: event.eventType,
    productId: event.productId,
    tenantId: event.tenantId,
    payload: JSON.stringify(event.payload),
    triggeredBy: event.triggeredBy ?? "",
    occurredAt: event.occurredAt.toISOString(),
    publishAttempts: String(event.publishAttempts)
  };
}

/**
 * Flatten the serialized record into the variadic `[k1, v1, k2, v2, ...]`
 * array that `redis.xadd(stream, "*", ...args)` expects.
 */
export function flattenSerializedFields(fields: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    out.push(k, v);
  }
  return out;
}
