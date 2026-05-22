// Tests for the outbox poller spawner (Task 5.6).
//
// Verifies the wiring boundary owned by this module: poller-worker spawn,
// immediate-kick + interval-driven backpressure measurement, and graceful
// shutdown.
//
// Real Postgres + real Redis. Postgres URL defaults to the dev DB used by
// `connectTestDb`; Redis URL defaults to redis://localhost:6379. Each test
// uses a fresh per-test tenant UUID and a fresh Redis stream name so
// concurrent test runs cannot collide.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test
} from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import IORedis from "ioredis";
import type { Logger } from "pino";
import {
  closeTestDb,
  connectTestDb,
  ensureTestTenant
} from "@aonex/db/testing";
import type { DrizzleClient, CatalogEvent } from "@aonex/db";
import { DEFAULT_KEY_PREFIX, type Publisher } from "@aonex/catalog-event-outbox";
import { startOutboxPoller, type OutboxHandle } from "./outbox-poller.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Default backpressure key prefix used by the spawner. Imported from the
// source of truth (`backpressure.ts`, re-exported via the package barrel)
// so this test stays coupled to the canonical constant.
const GLOBAL_THROTTLE_KEY = `${DEFAULT_KEY_PREFIX}:_global`;

let db: DrizzleClient;
let redis: IORedis;

// Per-test cleanup queues.
const tenantsToCleanup: string[] = [];
const streamNamesToCleanup: string[] = [];
const dedupeKeysToCleanup: string[] = [];

beforeAll(async () => {
  db = await connectTestDb();
  await ensureTestTenant(db);
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  await redis.quit();
  await closeTestDb();
});

afterEach(async () => {
  // Postgres cleanup — DLQ first (FK-free, but order matches the
  // poller test pattern).
  while (tenantsToCleanup.length > 0) {
    const t = tenantsToCleanup.pop()!;
    await db.execute(sql`
      DELETE FROM catalog_events_dlq
      WHERE event_id IN (SELECT event_id FROM catalog_events WHERE tenant_id = ${t})
    `);
    await db.execute(sql`DELETE FROM catalog_events WHERE tenant_id = ${t}`);
  }

  // Redis cleanup: streams + dedupe keys + global throttle key.
  if (streamNamesToCleanup.length > 0) {
    await redis.del(...streamNamesToCleanup);
    streamNamesToCleanup.length = 0;
  }
  if (dedupeKeysToCleanup.length > 0) {
    await redis.del(...dedupeKeysToCleanup);
    dedupeKeysToCleanup.length = 0;
  }
  // Always clear the global throttle key so cross-test backpressure
  // signals don't bleed.
  await redis.del(GLOBAL_THROTTLE_KEY);
});

function freshTenantId(): string {
  const id = randomUUID();
  tenantsToCleanup.push(id);
  return id;
}

function freshStreamName(): string {
  const name = `catalog.events:test:${randomUUID()}`;
  streamNamesToCleanup.push(name);
  return name;
}

/** Build a quiet pino-compatible logger so test output stays readable. */
function makeQuietLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {}
  } as unknown as Logger;
}

/** Insert one unpublished event scoped to `tenantId`. Returns its event_id. */
async function seedUnpublishedEvent(tenantId: string): Promise<number> {
  const occurredAt = new Date(Date.parse("2026-05-22T12:00:00Z"));
  const res = await db.execute(sql`
    INSERT INTO catalog_events
      (event_type, product_id, tenant_id, payload, occurred_at, publish_attempts)
    VALUES
      ('catalog.product.created',
       ${randomUUID()},
       ${tenantId},
       ${JSON.stringify({ seed: 1 })}::jsonb,
       ${occurredAt.toISOString()},
       0)
    RETURNING event_id
  `);
  const row = res.rows[0] as { event_id: string | number } | undefined;
  if (!row) throw new Error("Insert returned no row");
  const eventId = Number(row.event_id);
  // The RedisStreamsPublisher writes a dedupe key per event id; track it
  // so afterEach can DEL it.
  dedupeKeysToCleanup.push(`catalog:event-outbox:published:${eventId}`);
  return eventId;
}

async function fetchEvent(eventId: number): Promise<{
  publishedAt: Date | null;
  publishAttempts: number;
} | null> {
  const res = await db.execute(sql`
    SELECT published_at, publish_attempts
    FROM catalog_events
    WHERE event_id = ${eventId}
    LIMIT 1
  `);
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as {
    published_at: Date | string | null;
    publish_attempts: number;
  };
  return {
    publishedAt:
      r.published_at === null
        ? null
        : r.published_at instanceof Date
          ? r.published_at
          : new Date(r.published_at),
    publishAttempts: r.publish_attempts
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 50
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startOutboxPoller — happy path", () => {
  test("spawns workers + interval, returns a handle", async () => {
    const logger = makeQuietLogger();
    const streamName = freshStreamName();

    let handle: OutboxHandle | null = null;
    try {
      handle = await startOutboxPoller(
        { db, connection: redis, logger },
        {
          streamName,
          // Slow the interval down so tests are deterministic — the
          // immediate kick is the assertion target here.
          backpressureIntervalMs: 60_000
        }
      );

      expect(handle).not.toBeNull();
      expect(handle!.workers.length).toBe(4);
      expect(typeof handle!.stop).toBe("function");

      // Immediate-kick: a backpressure signal should appear in Redis
      // shortly after start.
      const wrote = await waitFor(
        async () => (await redis.get(GLOBAL_THROTTLE_KEY)) !== null,
        2000
      );
      expect(wrote).toBe(true);
    } finally {
      if (handle) await handle.stop();
    }
  });

  test("end-to-end: a seeded event is claimed, published, and marked", async () => {
    const tenantId = freshTenantId();
    const logger = makeQuietLogger();
    const streamName = freshStreamName();
    const eventId = await seedUnpublishedEvent(tenantId);

    let handle: OutboxHandle | null = null;
    try {
      handle = await startOutboxPoller(
        { db, connection: redis, logger },
        {
          streamName,
          backpressureIntervalMs: 60_000
        }
      );
      expect(handle).not.toBeNull();

      // Wait for the row to be marked published_at.
      const ok = await waitFor(async () => {
        const row = await fetchEvent(eventId);
        return row?.publishedAt !== null && row?.publishedAt !== undefined;
      }, 5000);
      expect(ok).toBe(true);

      // The Redis stream got exactly one entry (single seeded event +
      // publisher-side dedupe key ensures exactly-once).
      const xlen = await redis.xlen(streamName);
      expect(xlen).toBe(1);

      // The backpressure signal level is "none" (fewer than 10K
      // unpublished events globally).
      const wrote = await waitFor(
        async () => (await redis.get(GLOBAL_THROTTLE_KEY)) !== null,
        2000
      );
      expect(wrote).toBe(true);
      const signalRaw = await redis.get(GLOBAL_THROTTLE_KEY);
      expect(signalRaw).not.toBeNull();
      const signal = JSON.parse(signalRaw!) as { level: string };
      expect(signal.level).toBe("none");
    } finally {
      if (handle) await handle.stop();
    }
  });

  test("backpressure interval fires repeatedly", async () => {
    const logger = makeQuietLogger();
    const streamName = freshStreamName();

    let handle: OutboxHandle | null = null;
    // Inject a mock publisher so we don't spam real Redis stream entries.
    const noopPublisher: Publisher = {
      async publish(events: CatalogEvent[]) {
        return { published: events.length, failed: [] };
      }
    };

    try {
      handle = await startOutboxPoller(
        { db, connection: redis, logger },
        {
          streamName,
          backpressureIntervalMs: 100,
          publisher: noopPublisher
        }
      );
      expect(handle).not.toBeNull();

      // Track how many times the throttle key is rewritten. Since each
      // SET refreshes the value (and TTL), we sample by reading the
      // `measuredAt` field on each poll. Distinct `measuredAt` values
      // indicate distinct ticks.
      const seenMeasuredAt = new Set<string>();
      const stopAt = Date.now() + 500;
      while (Date.now() < stopAt) {
        const raw = await redis.get(GLOBAL_THROTTLE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { measuredAt: string };
          seenMeasuredAt.add(parsed.measuredAt);
        }
        await sleep(25);
      }
      // Expect at least 2 ticks (immediate + at least one interval) over
      // ~500ms with a 100ms cadence. We're conservative because the
      // immediate kick races with the first interval; 2 is the floor.
      expect(seenMeasuredAt.size).toBeGreaterThanOrEqual(2);
    } finally {
      if (handle) await handle.stop();
    }
  });

  test("stop() resolves cleanly and clears the interval", async () => {
    const logger = makeQuietLogger();
    const streamName = freshStreamName();

    const handle = await startOutboxPoller(
      { db, connection: redis, logger },
      {
        streamName,
        backpressureIntervalMs: 100
      }
    );
    expect(handle).not.toBeNull();

    // Wait for at least one tick to happen so the interval is live.
    await waitFor(
      async () => (await redis.get(GLOBAL_THROTTLE_KEY)) !== null,
      2000
    );

    // stop() must resolve.
    await handle!.stop();

    // Read the throttle key NOW, then wait longer than the interval —
    // if `clearInterval` failed, the value (measuredAt) would change.
    const before = await redis.get(GLOBAL_THROTTLE_KEY);
    await sleep(300); // 3x the interval cadence
    const after = await redis.get(GLOBAL_THROTTLE_KEY);

    // Either both null (TTL expired) or both equal — neither has been
    // refreshed by a post-stop tick.
    expect(after).toBe(before);
  });
});
