// Default `Publisher` backend: Redis Streams via `XADD`.
//
// See plan task 5.2 and spec §19.1.
//
// Contract:
//   * `publish(events)` writes one stream entry per event to the configured
//     stream. Each entry's fields match `serializeEventForStream` (see
//     `../publisher.ts`).
//   * **Idempotency:** the SAME `event_id` published twice results in only
//     one stream entry. The dedupe guard is a Redis `SET NX EX <ttl>` key
//     keyed on `eventId`. If the SET claim fails, the event is treated as
//     already-published and **counted in neither `published` nor `failed`**.
//   * **Failure isolation:** publishing each event is independent. A failure
//     on event N does not abort events N+1..K.
//   * **Empty batch:** `publish([])` resolves immediately with
//     `{ published: 0, failed: [] }` and issues no Redis commands.
//
// Why a SET-then-XADD dedupe guard (instead of stream-native IDs)?
//   Redis Stream entry IDs are `<ms>-<seq>` and must be monotonically
//   increasing per stream — you cannot pass an arbitrary stable ID derived
//   from `event_id` without breaking ordering for late-arriving events.
//   The canonical idempotency pattern is therefore an out-of-band claim.
//
// Why a Lua script (instead of two sequential JS calls)?
//   We want "claim + XADD" to be atomic against a connection drop or a
//   second worker racing on the same eventId. The script does both in one
//   round-trip; ioredis caches and reuses it via `defineCommand`.
//
// Known v1 limitation:
//   If the dedupe SET succeeds inside the Lua script but the script's XADD
//   later fails server-side (e.g., OOM), we leave the SET key in place. A
//   retry will see the dedupe key as claimed and **skip** the event. This
//   is acceptable in v1 because the outbox poller (task 5.3) retries at
//   the catalog_events row level (publish_attempts) and will route stuck
//   rows to the DLQ; nothing is silently lost.

import type { Redis as IORedis } from "ioredis";
import type { CatalogEvent, Publisher } from "../types.js";
import { serializeEventForStream } from "../publisher.js";

const DEFAULT_DEDUPE_PREFIX = "catalog:event-outbox:published";
/** 30 days — matches catalog_events partition retention (spec §19.1). */
const DEFAULT_DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface RedisStreamsPublisherOptions {
  /** Live ioredis client. The publisher does NOT own the connection. */
  redis: IORedis;
  /** Target stream name. The same name is used for every event in v1. */
  streamName: string;
  /**
   * Override for the dedupe key prefix. Final key is
   * `<prefix>:<eventId>`. Default: `catalog:event-outbox:published`.
   */
  dedupeKeyPrefix?: string;
  /** TTL for the dedupe key in seconds. Default: 30 days. */
  dedupeTtlSeconds?: number;
}

/**
 * Atomic "claim eventId + XADD" Lua script.
 *
 * KEYS[1] = dedupe key (`<prefix>:<eventId>`)
 * KEYS[2] = stream name
 * ARGV[1] = dedupe TTL (seconds)
 * ARGV[2..] = alternating field, value pairs for XADD
 *
 * Returns the new stream entry ID on success, or `false` (nil) if the
 * dedupe key was already set (i.e. the event was already published).
 *
 * Stream retention (MAXLEN) is the *bus's* responsibility per spec §19.1,
 * not the publisher's — this script intentionally does no trimming.
 */
const CLAIM_AND_XADD_SCRIPT = `
local claimed = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1])
if not claimed then
  return false
end
local fields = {}
for i = 2, #ARGV do
  fields[#fields + 1] = ARGV[i]
end
return redis.call('XADD', KEYS[2], '*', unpack(fields))
`;

// Symbol used to register the script on the ioredis client once. We add a
// matching property to the prototype-less call surface via defineCommand,
// so the second client to be passed in also gets a fresh registration —
// defineCommand is idempotent per-instance.
//
// Exported for tests only (so the failure-isolation test can patch the
// command without duplicating the magic string). NOT re-exported from
// `src/index.ts` — package-internal.
export const COMMAND_NAME = "aonexCatalogPublishEvent";

interface CommanderWithCustom extends IORedis {
  [COMMAND_NAME]: (
    dedupeKey: string,
    streamKey: string,
    ttl: string,
    ...fields: string[]
  ) => Promise<string | null>;
}

function ensureCommandRegistered(redis: IORedis): CommanderWithCustom {
  const cmd = redis as CommanderWithCustom;
  if (typeof cmd[COMMAND_NAME] !== "function") {
    redis.defineCommand(COMMAND_NAME, {
      numberOfKeys: 2,
      lua: CLAIM_AND_XADD_SCRIPT
    });
  }
  return cmd;
}

export class RedisStreamsPublisher implements Publisher {
  private readonly redis: CommanderWithCustom;
  private readonly streamName: string;
  private readonly dedupeKeyPrefix: string;
  private readonly dedupeTtlSeconds: number;

  constructor(opts: RedisStreamsPublisherOptions) {
    this.redis = ensureCommandRegistered(opts.redis);
    this.streamName = opts.streamName;
    this.dedupeKeyPrefix = opts.dedupeKeyPrefix ?? DEFAULT_DEDUPE_PREFIX;
    this.dedupeTtlSeconds = opts.dedupeTtlSeconds ?? DEFAULT_DEDUPE_TTL_SECONDS;
  }

  /** The fully-qualified dedupe key for a given eventId. */
  dedupeKeyFor(eventId: number | bigint): string {
    return `${this.dedupeKeyPrefix}:${eventId}`;
  }

  /**
   * Publish a batch of events to the configured Redis stream.
   *
   * Returns `{ published, failed }` where `published` is the count of
   * **newly** written stream entries and `failed[]` carries
   * `{ event, reason }` for every event whose claim+XADD threw.
   *
   * **Idempotency:** a duplicate event (same `eventId` as a previous
   * successful publish within the dedupe TTL window) is counted in
   * **neither** `published` **nor** `failed` — it is a silent no-op,
   * exactly matching the contract that the outbox poller relies on.
   *
   * **Dedupe TTL:** defaults to `DEFAULT_DEDUPE_TTL_SECONDS` (30 days,
   * matching spec §19.1 partition retention). Override via
   * `RedisStreamsPublisherOptions.dedupeTtlSeconds`.
   *
   * See the file header for the v1 limitation around SET-succeeds /
   * server-side-XADD-fails (next retry skips; the outbox row-level
   * `publish_attempts` + DLQ path covers it).
   */
  async publish(events: CatalogEvent[]): Promise<{
    published: number;
    failed: { event: CatalogEvent; reason: string }[];
  }> {
    if (events.length === 0) {
      return { published: 0, failed: [] };
    }

    const failed: { event: CatalogEvent; reason: string }[] = [];
    let published = 0;

    const ttlArg = String(this.dedupeTtlSeconds);

    // Sequential, not pipelined: each event needs its own claim+XADD result.
    // Batches in v1 are small (poller batchSize default = 100) so this is
    // fine. If a connection drop happens mid-batch the unaffected events
    // still publish; the failed ones land in `failed[]`.
    for (const event of events) {
      const dedupeKey = this.dedupeKeyFor(event.eventId);
      const fields = serializeEventForStream(event);
      const fieldArgs: string[] = [];
      for (const [k, v] of Object.entries(fields)) {
        fieldArgs.push(k, v);
      }

      try {
        const result = await this.redis[COMMAND_NAME](
          dedupeKey,
          this.streamName,
          ttlArg,
          ...fieldArgs
        );
        // result === null → dedupe key already existed; event was previously
        // published. NOT counted in `published` (it's not a NEW publish) and
        // NOT a failure either. This matches the contract documented above.
        if (result !== null) {
          published++;
        }
      } catch (err: unknown) {
        failed.push({
          event,
          reason: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return { published, failed };
  }
}
