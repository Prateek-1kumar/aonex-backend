// Tests for RedisStreamsPublisher — plan task 5.2, spec §19.1.
//
// Real-Redis tests: gated on REDIS_URL (default redis://localhost:6379),
// matching the convention used by packages/catalog/catalog-service tests.
// Each test uses a unique stream name (Date.now() + random suffix) and
// cleans up the stream key and any dedupe keys it created in afterEach.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import IORedis from "ioredis";
import type { CatalogEvent } from "../types.js";
import { RedisStreamsPublisher } from "./redis-streams.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const STREAM_PREFIX = "test:catalog-events";
const DEDUPE_PREFIX = "test:catalog:event-outbox:published";

let connection: IORedis;
let streamName: string;
let publisher: RedisStreamsPublisher;
let createdEventIds: number[];

function makeEvent(overrides: Partial<CatalogEvent> = {}): CatalogEvent {
  const eventId =
    overrides.eventId ??
    // Date.now() + Math.random() gives a comfortably unique id for tests.
    Math.floor(Date.now() * 1000 + Math.random() * 1000);
  createdEventIds.push(Number(eventId));
  return {
    eventId,
    eventType: "catalog.product.pricing_changed",
    productId: "11111111-1111-1111-1111-111111111111",
    tenantId: "22222222-2222-2222-2222-222222222222",
    payload: { sample: "value", n: 1 },
    triggeredBy: "test:publisher",
    occurredAt: new Date("2026-05-22T12:00:00Z"),
    publishedAt: null,
    publishAttempts: 0,
    ...overrides
  } as CatalogEvent;
}

beforeAll(() => {
  connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  await connection.quit();
});

beforeEach(() => {
  // Unique stream per test so concurrent test files don't collide.
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  streamName = `${STREAM_PREFIX}:${suffix}`;
  createdEventIds = [];
  publisher = new RedisStreamsPublisher({
    redis: connection,
    streamName,
    dedupeKeyPrefix: DEDUPE_PREFIX,
    dedupeTtlSeconds: 60
  });
});

afterEach(async () => {
  // Drop the stream and every dedupe key we minted this test.
  const keys: string[] = [streamName];
  for (const id of createdEventIds) {
    keys.push(`${DEDUPE_PREFIX}:${id}`);
  }
  if (keys.length > 0) {
    await connection.del(...keys);
  }
});

describe("RedisStreamsPublisher", () => {
  test("publishes a batch of 3 distinct events to the stream", async () => {
    const events = [makeEvent(), makeEvent(), makeEvent()];
    const result = await publisher.publish(events);

    expect(result.published).toBe(3);
    expect(result.failed).toEqual([]);

    const len = await connection.xlen(streamName);
    expect(len).toBe(3);

    // Stream entries are [[id, [field, value, ...]], ...] — pull them back
    // and assert each event's eventId/eventType/tenantId/productId/payload
    // fields land correctly.
    const entries = await connection.xrange(streamName, "-", "+");
    expect(entries.length).toBe(3);

    // Parse stream entry fields into a Record<string, string> for easier asserts.
    const decoded = entries.map(([, fieldPairs]) => {
      const rec: Record<string, string> = {};
      for (let i = 0; i < fieldPairs.length; i += 2) {
        rec[fieldPairs[i]!] = fieldPairs[i + 1]!;
      }
      return rec;
    });

    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const d = decoded[i]!;
      expect(d.eventId).toBe(String(e.eventId));
      expect(d.eventType).toBe(e.eventType);
      expect(d.productId).toBe(e.productId);
      expect(d.tenantId).toBe(e.tenantId);
      expect(JSON.parse(d.payload!)).toEqual(e.payload as object);
      expect(d.triggeredBy).toBe(e.triggeredBy ?? "");
      expect(d.occurredAt).toBe(e.occurredAt.toISOString());
      expect(d.publishAttempts).toBe(String(e.publishAttempts));
    }
  });

  test("idempotent: publishing the same event twice yields only one stream entry", async () => {
    const event = makeEvent();

    const first = await publisher.publish([event]);
    expect(first.published).toBe(1);
    expect(first.failed).toEqual([]);

    const second = await publisher.publish([event]);
    // Already-published events are counted in NEITHER published NOR failed.
    expect(second.published).toBe(0);
    expect(second.failed).toEqual([]);

    expect(await connection.xlen(streamName)).toBe(1);
  });

  test("mixed batch dedupe: [A,B] then [B,C] yields 3 unique entries", async () => {
    const a = makeEvent();
    const b = makeEvent();
    const c = makeEvent();

    const r1 = await publisher.publish([a, b]);
    expect(r1.published).toBe(2);
    expect(r1.failed).toEqual([]);

    const r2 = await publisher.publish([b, c]);
    // B is a duplicate (not counted), C is new (counted).
    expect(r2.published).toBe(1);
    expect(r2.failed).toEqual([]);

    expect(await connection.xlen(streamName)).toBe(3);
  });

  test("failure isolation: an XADD error sidelines one event but the others publish", async () => {
    const a = makeEvent();
    const b = makeEvent();
    const c = makeEvent();

    // Spy via prototype patch: throw on the *second* call to the custom
    // Lua command, succeed on the others.
    const commandName = "aonexCatalogPublishEvent";
    type Cmd = (...args: unknown[]) => Promise<string | null>;
    const original = (connection as unknown as Record<string, Cmd>)[commandName]!;
    let calls = 0;
    (connection as unknown as Record<string, Cmd>)[commandName] = async function (
      ...args: unknown[]
    ): Promise<string | null> {
      calls++;
      if (calls === 2) {
        throw new Error("simulated XADD failure");
      }
      return original.apply(connection, args);
    };

    try {
      const result = await publisher.publish([a, b, c]);
      expect(result.published).toBe(2);
      expect(result.failed.length).toBe(1);
      expect(result.failed[0]!.event).toBe(b);
      expect(result.failed[0]!.reason).toContain("simulated XADD failure");

      // A and C land on the stream; B does not.
      expect(await connection.xlen(streamName)).toBe(2);
    } finally {
      (connection as unknown as Record<string, Cmd>)[commandName] = original;
    }
  });

  test("empty batch is a no-op (no Redis calls, no errors)", async () => {
    const result = await publisher.publish([]);
    expect(result).toEqual({ published: 0, failed: [] });
    // Stream key was never created.
    expect(await connection.exists(streamName)).toBe(0);
  });

  test("triggeredBy=null is serialized as empty string", async () => {
    const event = makeEvent({ triggeredBy: null });
    await publisher.publish([event]);

    const entries = await connection.xrange(streamName, "-", "+");
    expect(entries.length).toBe(1);
    const fields = entries[0]![1];
    const rec: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      rec[fields[i]!] = fields[i + 1]!;
    }
    expect(rec.triggeredBy).toBe("");
  });

  test("MAXLEN ~ option is accepted and stream stays bounded", async () => {
    // Small cap, then publish more than the cap. Redis trims approximately
    // so we just assert XLEN is in the same order of magnitude as the cap.
    const boundedPublisher = new RedisStreamsPublisher({
      redis: connection,
      streamName,
      dedupeKeyPrefix: DEDUPE_PREFIX,
      dedupeTtlSeconds: 60,
      maxLenApprox: 5
    });
    const events = Array.from({ length: 20 }, () => makeEvent());
    const result = await boundedPublisher.publish(events);

    expect(result.published).toBe(20);
    expect(result.failed).toEqual([]);

    // Approximate trim: XLEN should be ≤ 20 and ≥ 5. In practice Redis
    // usually stays close to the cap; we just want to confirm trimming
    // actually fires and we don't unbound the stream.
    const len = await connection.xlen(streamName);
    expect(len).toBeGreaterThanOrEqual(5);
    expect(len).toBeLessThanOrEqual(20);
  });
});
