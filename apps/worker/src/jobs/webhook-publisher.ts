// Webhook consumer — Phase 5 §5.7
//
// Reads from the Redis Stream populated by `RedisStreamsPublisher` (Task 5.2)
// via a consumer group, parses each event, looks up subscribed tenant
// webhooks, and POSTs the event payload. Retries on 5xx and network errors;
// gives up on 4xx (caller bug).
//
// v1 limitations (intentional — see plan §5.7):
//   - Filtered to `catalog.product.{created, updated, deleted}` per spec §19
//     v1. The filter is forward-compatible: if `deleted` is never emitted by
//     the current catalog, the consumer simply never sees an entry of that
//     type and skip-counts it like any other off-list event.
//   - No HMAC signing (column reserved on tenant_webhooks; v2 wires).
//   - Retries: `maxAttempts` (default 3) with exponential backoff + small
//     jitter. Per-tenant log row on final failure; no separate DLQ.
//   - Stats counters live in-memory on the handle. No persistent failure
//     log table in v1.
//   - One Stream + one consumer group per worker process. Sharding/scale-out
//     happens by running multiple worker processes with the SAME group
//     name and DIFFERENT consumer names — Redis distributes entries.
//   - Failure logs are NOT rate-limited; a permanently-down webhook produces
//     one warn line per event. Operators with monitoring can wire log
//     rate-limits in their log pipeline. Future: in-process throttling
//     per-tenant.
//
// Idempotency (spec §19.1):
//   Each event carries an `eventId`. Consumers dedupe by `eventId`. The
//   Redis consumer-group machinery (`XREADGROUP` + `XACK`) gives at-least-
//   once delivery; the receiving HTTP endpoint MUST dedupe by `eventId` on
//   its side. We do NOT track per-event dedupe in Redis here — the publisher
//   already dedupes XADD writes, so any duplicate we see comes from a
//   redelivery of an un-ACKed entry (e.g., consumer crash), which is the
//   correct semantic.
//
// XACK policy (delivered vs failed):
//   We XACK on EVERY processed entry — including ones whose HTTP delivery
//   ultimately failed. Rationale: v1 has no retry-loop reclaim, so leaving
//   an entry un-ACKed would not actually retry it. Worse, it would block
//   the pending-entries list indefinitely. The failed-delivery signal is
//   carried in the in-memory `stats.failed` counter + a warn log; operators
//   reconcile via the receiving system's eventId dedupe + the catalog_events
//   table itself (the source of truth for what was published).
//
// Wiring: this module exposes the consumer factory only. It is NOT booted
// from the composition root in this task (plan §5.7 explicitly scopes that
// follow-up). Production wiring will arrive alongside the v1 admin endpoint
// for managing tenant_webhooks rows.

import { randomUUID } from "node:crypto";
import type IORedis from "ioredis";
import type { Logger } from "pino";
import type { DrizzleClient } from "@aonex/db";
import { schema } from "@aonex/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * v1 accepted event types (spec §19 + plan §5.7). Filtering by an array on
 * the consumer side (rather than per-tenant-webhook config) keeps the v1
 * blast radius small and makes admin onboarding "just enter a URL".
 */
export const DEFAULT_ACCEPTED_EVENT_TYPES = [
  "catalog.product.created",
  "catalog.product.updated",
  "catalog.product.deleted"
] as const;

const DEFAULT_STREAM_NAME = "catalog.events";
const DEFAULT_GROUP_NAME = "catalog-webhook-consumer";
const DEFAULT_POLL_BLOCK_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
/** Default per-request HTTP timeout for webhook POSTs. */
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
/** Default XREADGROUP COUNT — max entries fetched per poll. */
const DEFAULT_BATCH_SIZE = 10;
/**
 * Cap exponential backoff sleep to keep stop() responsive.
 *
 * Caps single-sleep latency. With v1 default maxAttempts=3 + baseBackoffMs=1000,
 * total backoff is bounded at 1+2 ≈ 3s; the cap matters only if operator
 * raises maxAttempts.
 */
const MAX_BACKOFF_MS = 10_000;

export interface WebhookConsumerDeps {
  db: DrizzleClient;
  connection: IORedis;
  logger?: Logger;
}

export interface WebhookConsumerOptions {
  /** Redis Stream name. Default `catalog.events` (matches RedisStreamsPublisher default). */
  streamName?: string;
  /** Consumer group name. Default `catalog-webhook-consumer`. */
  groupName?: string;
  /** Consumer name within the group. Default `worker-${randomUUID()}`. */
  consumerName?: string;
  /** XREADGROUP block timeout in ms. Default 5000. */
  pollBlockMs?: number;
  /** Event types this consumer accepts. Default DEFAULT_ACCEPTED_EVENT_TYPES. */
  acceptedEventTypes?: readonly string[];
  /** Number of attempts per webhook POST. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms. Default 1000. */
  baseBackoffMs?: number;
  /** Per-request HTTP timeout in ms (AbortSignal). Default 15000. */
  httpTimeoutMs?: number;
  /** XREADGROUP COUNT — max stream entries per poll. Default 10. */
  batchSize?: number;
  /**
   * HTTP fetch implementation. Default global fetch. Tests inject a stub
   * to assert request shape + simulate failures without touching the
   * network.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional override for the Date.now-equivalent used in logs/jitter.
   * Tests can pin this for determinism. Default `() => Date.now()`.
   */
  now?: () => number;
}

export interface WebhookConsumerStats {
  delivered: number;
  failed: number;
  skipped: number;
  lastErr?: string;
}

export interface WebhookConsumerHandle {
  /**
   * Begin the read-loop. Idempotent within a single lifecycle — once
   * `stop()` has been called, restart is not supported (construct a new
   * consumer). Calling `start()` twice before `stop()` is a no-op: the
   * second call returns silently and the loop keeps running.
   */
  start(): void;
  /**
   * Signal the loop to terminate and wait for the in-flight iteration to
   * finish. Resolves after the loop has exited. Idempotent — safe to call
   * twice.
   */
  stop(): Promise<void>;
  /** Snapshot of in-memory counters. Safe to call anytime. */
  stats(): WebhookConsumerStats;
}

interface StreamEntryFields {
  eventId: string;
  eventType: string;
  productId: string;
  tenantId: string;
  payload: string;
  triggeredBy: string;
  occurredAt: string;
  publishAttempts: string;
}

/** Strict-validate a stream entry's fields. Returns null + reason on shape failures. */
function parseStreamFields(
  fieldPairs: string[]
): { ok: true; fields: StreamEntryFields } | { ok: false; reason: string } {
  const rec: Record<string, string> = {};
  for (let i = 0; i < fieldPairs.length; i += 2) {
    const k = fieldPairs[i];
    const v = fieldPairs[i + 1];
    if (k === undefined || v === undefined) {
      return { ok: false, reason: "malformed field pair" };
    }
    rec[k] = v;
  }
  const required = [
    "eventId",
    "eventType",
    "productId",
    "tenantId",
    "payload",
    "occurredAt"
  ] as const;
  for (const k of required) {
    if (rec[k] === undefined) {
      return { ok: false, reason: `missing field: ${k}` };
    }
  }
  return {
    ok: true,
    fields: {
      eventId: rec.eventId!,
      eventType: rec.eventType!,
      productId: rec.productId!,
      tenantId: rec.tenantId!,
      payload: rec.payload!,
      triggeredBy: rec.triggeredBy ?? "",
      occurredAt: rec.occurredAt!,
      publishAttempts: rec.publishAttempts ?? "0"
    }
  };
}

interface DeliveryResult {
  success: boolean;
  attempts: number;
  reason?: string;
}

/**
 * Sleep that resolves early if `aborted()` becomes true. Polls every ~50ms.
 * Used so `stop()` doesn't have to wait out a long backoff.
 */
async function abortableSleep(
  ms: number,
  aborted: () => boolean
): Promise<void> {
  const slice = 50;
  let remaining = ms;
  while (remaining > 0 && !aborted()) {
    const next = Math.min(slice, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, next));
    remaining -= next;
  }
}

/**
 * POST `body` to `url` with retries.
 *
 * Retry policy:
 *   - 5xx response and network-level errors (fetch throws, incl. timeouts
 *     via AbortSignal.timeout → AbortError) → retry up to `maxAttempts`
 *     total attempts, sleeping `base * 2^(n-1)` ms between attempts plus
 *     0-100ms jitter, capped at MAX_BACKOFF_MS.
 *   - 4xx response → no retry (caller bug). Surface as failed.
 *   - 2xx/3xx → success on first valid response.
 */
async function deliverWithRetries(args: {
  url: string;
  body: unknown;
  maxAttempts: number;
  baseBackoffMs: number;
  httpTimeoutMs: number;
  fetchImpl: typeof fetch;
  aborted: () => boolean;
}): Promise<DeliveryResult> {
  const {
    url,
    body,
    maxAttempts,
    baseBackoffMs,
    httpTimeoutMs,
    fetchImpl,
    aborted
  } = args;
  const serialized = JSON.stringify(body);
  let lastReason = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (aborted()) {
      return { success: false, attempts: attempt - 1, reason: "aborted" };
    }
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized,
        // AbortSignal.timeout throws an AbortError if the request exceeds
        // httpTimeoutMs. The catch below normalizes this to a network-style
        // reason and counts it as retryable.
        signal: AbortSignal.timeout(httpTimeoutMs)
      });
      if (res.status >= 200 && res.status < 300) {
        return { success: true, attempts: attempt };
      }
      if (res.status >= 400 && res.status < 500) {
        return {
          success: false,
          attempts: attempt,
          reason: `http_${res.status}`
        };
      }
      // 5xx or unexpected 3xx — retry.
      lastReason = `http_${res.status}`;
    } catch (err) {
      lastReason =
        err instanceof Error ? `network:${err.message}` : "network:unknown";
    }
    if (attempt < maxAttempts) {
      const jitter = Math.floor(Math.random() * 100);
      const delay = Math.min(
        baseBackoffMs * Math.pow(2, attempt - 1) + jitter,
        MAX_BACKOFF_MS
      );
      await abortableSleep(delay, aborted);
    }
  }
  return { success: false, attempts: maxAttempts, reason: lastReason };
}

/**
 * Build the webhook consumer.
 *
 * Lifecycle: `start()` kicks off the read-loop as a detached promise.
 * `stop()` signals it to exit and awaits the in-flight loop iteration.
 *
 * The consumer group is created lazily on first poll with MKSTREAM, so
 * starting against a not-yet-existent stream is safe.
 */
export function makeWebhookConsumer(
  deps: WebhookConsumerDeps,
  options: WebhookConsumerOptions = {}
): WebhookConsumerHandle {
  const { db, connection, logger } = deps;

  const streamName = options.streamName ?? DEFAULT_STREAM_NAME;
  const groupName = options.groupName ?? DEFAULT_GROUP_NAME;
  const consumerName =
    options.consumerName ?? `worker-${randomUUID()}`;
  const pollBlockMs = options.pollBlockMs ?? DEFAULT_POLL_BLOCK_MS;
  const acceptedEventTypes = new Set(
    options.acceptedEventTypes ?? DEFAULT_ACCEPTED_EVENT_TYPES
  );
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const fetchImpl = options.fetchImpl ?? fetch;

  const stats: WebhookConsumerStats = {
    delivered: 0,
    failed: 0,
    skipped: 0
  };

  let started = false;
  let stopping = false;
  let loopDone: Promise<void> | null = null;
  const aborted = (): boolean => stopping;

  async function ensureGroup(): Promise<void> {
    try {
      // 0 = start at the beginning of the stream; MKSTREAM creates the
      // stream if it doesn't yet exist so we don't race the publisher.
      await connection.xgroup(
        "CREATE",
        streamName,
        groupName,
        "0",
        "MKSTREAM"
      );
    } catch (err) {
      // ioredis surfaces the redis reply text verbatim in err.message; the
      // canonical reply for an already-existing group is
      // `BUSYGROUP Consumer Group name already exists`. Anchor at line-start
      // (with optional whitespace) + word boundary to avoid false positives
      // from substrings inside arbitrary error text.
      const isBusyGroup =
        err instanceof Error && /^\s*BUSYGROUP\b/i.test(err.message);
      if (isBusyGroup) return; // already created — fine
      throw err;
    }
  }

  async function processOne(
    streamId: string,
    fieldPairs: string[]
  ): Promise<void> {
    const parsed = parseStreamFields(fieldPairs);
    if (!parsed.ok) {
      stats.skipped++;
      stats.lastErr = `parse: ${parsed.reason}`;
      logger?.warn(
        { streamId, reason: parsed.reason },
        "webhook.entry.malformed"
      );
      await connection.xack(streamName, groupName, streamId);
      return;
    }
    const f = parsed.fields;

    if (!acceptedEventTypes.has(f.eventType)) {
      stats.skipped++;
      await connection.xack(streamName, groupName, streamId);
      return;
    }

    // Look up active webhooks for this tenant whose event_types include this
    // event type. `ANY(event_types)` is the postgres array membership test.
    const rows = await db
      .select({
        id: schema.tenantWebhooks.id,
        url: schema.tenantWebhooks.url
      })
      .from(schema.tenantWebhooks)
      .where(
        and(
          eq(schema.tenantWebhooks.tenantId, f.tenantId),
          eq(schema.tenantWebhooks.active, true),
          sql`${f.eventType} = ANY(${schema.tenantWebhooks.eventTypes})`
        )
      );

    if (rows.length === 0) {
      stats.skipped++;
      await connection.xack(streamName, groupName, streamId);
      return;
    }

    // Parse payload once (per-entry); shape is JSON serialized by the
    // publisher per `serializeEventForStream` in @aonex/catalog-event-outbox.
    let payload: unknown;
    try {
      payload = JSON.parse(f.payload);
    } catch {
      // Treat as opaque string — downstream will see it as a string. We do
      // NOT skip: the catalog publisher controls payload shape, so this is
      // a "shouldn't happen" path; still, we don't want to ACK-and-drop.
      // Fall through with the raw string.
      payload = f.payload;
    }

    const body = {
      eventId: f.eventId,
      eventType: f.eventType,
      productId: f.productId,
      tenantId: f.tenantId,
      occurredAt: f.occurredAt,
      ...(f.triggeredBy ? { triggeredBy: f.triggeredBy } : {}),
      payload
    };

    // Deliveries to different webhook rows for the same tenant are
    // independent — run them concurrently. `allSettled` so one webhook's
    // unexpected throw doesn't block siblings; per-row failure already
    // returns a `DeliveryResult` via the catch inside `deliverWithRetries`,
    // so the `rejected` branch here is truly defensive (shouldn't fire).
    const settlements = await Promise.allSettled(
      rows.map((w) =>
        deliverWithRetries({
          url: w.url,
          body,
          maxAttempts,
          baseBackoffMs,
          httpTimeoutMs,
          fetchImpl,
          aborted
        }).then((result) => ({ w, result }))
      )
    );
    for (const s of settlements) {
      if (s.status === "rejected") {
        stats.failed++;
        const msg =
          s.reason instanceof Error ? s.reason.message : String(s.reason);
        stats.lastErr = `deliver:${msg}`;
        logger?.warn(
          {
            eventId: f.eventId,
            eventType: f.eventType,
            reason: msg
          },
          "webhook.failed"
        );
        continue;
      }
      const { w, result } = s.value;
      if (result.success) {
        stats.delivered++;
        logger?.debug(
          {
            webhookId: w.id,
            eventId: f.eventId,
            eventType: f.eventType,
            attempts: result.attempts
          },
          "webhook.delivered"
        );
      } else {
        stats.failed++;
        if (result.reason !== undefined) stats.lastErr = result.reason;
        logger?.warn(
          {
            webhookId: w.id,
            eventId: f.eventId,
            eventType: f.eventType,
            attempts: result.attempts,
            reason: result.reason
          },
          "webhook.failed"
        );
      }
    }

    // ACK regardless of delivery success (see file header — XACK policy).
    await connection.xack(streamName, groupName, streamId);
  }

  type XreadGroupResult =
    | null
    | [stream: string, entries: [id: string, fields: string[]][]][];

  async function runLoop(): Promise<void> {
    await ensureGroup();
    while (!stopping) {
      let entries: XreadGroupResult = null;
      try {
        // `>` = "only entries never delivered to any consumer in this group".
        // Bun's ioredis types loosely type the result; cast to our narrowed shape.
        entries = (await connection.xreadgroup(
          "GROUP",
          groupName,
          consumerName,
          "COUNT",
          batchSize,
          "BLOCK",
          pollBlockMs,
          "STREAMS",
          streamName,
          ">"
        )) as XreadGroupResult;
      } catch (err) {
        if (stopping) return;
        const msg = err instanceof Error ? err.message : String(err);
        stats.lastErr = `xreadgroup:${msg}`;
        logger?.error({ err: msg }, "webhook.xreadgroup.failed");
        // Back off briefly before retrying so a persistent Redis problem
        // doesn't tight-loop.
        await abortableSleep(1_000, aborted);
        continue;
      }
      if (!entries) continue; // BLOCK timeout — loop and try again.

      for (const [, streamEntries] of entries) {
        for (const [streamId, fieldPairs] of streamEntries) {
          if (stopping) return;
          try {
            await processOne(streamId, fieldPairs);
          } catch (err) {
            // Defensive: never let a per-entry error kill the loop.
            stats.failed++;
            const msg = err instanceof Error ? err.message : String(err);
            stats.lastErr = `process:${msg}`;
            logger?.error(
              { streamId, err: msg },
              "webhook.entry.unexpected_error"
            );
            // ACK to prevent a poison entry from blocking the consumer
            // group forever (see XACK policy in file header).
            try {
              await connection.xack(streamName, groupName, streamId);
            } catch {
              // best-effort
            }
          }
        }
      }
    }
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      loopDone = runLoop().catch((err) => {
        // Should never reach here — runLoop catches per-iteration errors —
        // but if `ensureGroup` throws non-BUSYGROUP we land here.
        const msg = err instanceof Error ? err.message : String(err);
        stats.lastErr = `fatal:${msg}`;
        logger?.error({ err: msg }, "webhook.consumer.fatal");
      });
    },
    async stop(): Promise<void> {
      stopping = true;
      if (loopDone) {
        await loopDone;
      }
    },
    stats(): WebhookConsumerStats {
      // Copy so callers can't mutate internal state.
      return { ...stats };
    }
  };
}
