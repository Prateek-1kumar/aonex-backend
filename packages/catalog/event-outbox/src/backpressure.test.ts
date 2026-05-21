// Tests for the outbox backpressure signal — plan task 5.4, spec §19.1.
//
// Real Postgres + real Redis. Postgres URL defaults to the dev DB used by
// `connectTestDb`; Redis URL defaults to redis://localhost:6379. Each test
// uses a fresh tenant UUID so concurrent test runs do not contaminate each
// other, and an isolated Redis key prefix so any leaked keys do not bleed
// across files.
//
// Threshold-boundary tests use a small `thresholds` override
// (softMin=5, hardMin=100, emergencyMin=1_000) so we can verify boundary
// behaviour without inserting half a million rows. The default thresholds
// are themselves verified by the pure-function `classifyThrottle` tests.

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
import {
  closeTestDb,
  connectTestDb,
  ensureTestTenant
} from "@aonex/db/testing";
import type { DrizzleClient } from "@aonex/db";
import {
  DEFAULT_THRESHOLDS,
  __INTERNAL_FOR_TESTS,
  classifyThrottle,
  getCurrentThrottleLevel,
  getCurrentThrottleSignal,
  measureAndPublishBackpressure
} from "./backpressure.js";
import type { ThrottleSignal, ThrottleThresholds } from "./backpressure.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Isolated key prefix so test runs cannot collide with real signals or with
// each other.
const TEST_KEY_PREFIX = `test:catalog:event-outbox:throttle:${randomUUID()}`;

let db: DrizzleClient;
let redis: IORedis;
// Each test pushes the tenants / Redis keys it created into these lists,
// and `afterEach` drains them. We don't SCAN-and-delete by prefix because
// Bun's redis client doesn't expose a batched scan; explicit tracking is
// simpler and faster anyway.
const tenantsToCleanup: string[] = [];
const keysToCleanup: string[] = [];

beforeAll(async () => {
  db = await connectTestDb();
  await ensureTestTenant(db);
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  await closeTestDb();
  await redis.quit();
});

afterEach(async () => {
  // Postgres cleanup
  while (tenantsToCleanup.length > 0) {
    const t = tenantsToCleanup.pop()!;
    await db.execute(sql`
      DELETE FROM catalog_events_dlq
      WHERE event_id IN (SELECT event_id FROM catalog_events WHERE tenant_id = ${t})
    `);
    await db.execute(sql`DELETE FROM catalog_events WHERE tenant_id = ${t}`);
  }

  // Redis cleanup
  if (keysToCleanup.length > 0) {
    await redis.del(...keysToCleanup);
    keysToCleanup.length = 0;
  }
});

/** Returns a tenant id unique to one test so concurrent runs don't collide. */
function freshTenantId(): string {
  const id = randomUUID();
  tenantsToCleanup.push(id);
  return id;
}

/** Insert N unpublished events scoped to `tenantId`. */
async function seedUnpublishedEvents(opts: {
  tenantId: string;
  count: number;
}): Promise<void> {
  const base = new Date(Date.parse("2026-05-22T12:00:00Z"));
  for (let i = 0; i < opts.count; i++) {
    const occurredAt = new Date(base.getTime() + i * 1000);
    await db.execute(sql`
      INSERT INTO catalog_events
        (event_type, product_id, tenant_id, payload, occurred_at, publish_attempts)
      VALUES
        ('catalog.product.created',
         ${randomUUID()},
         ${opts.tenantId},
         ${JSON.stringify({ seed: i })}::jsonb,
         ${occurredAt.toISOString()},
         0)
    `);
  }
}

function trackKey(tenantId: string | null): string {
  const key = __INTERNAL_FOR_TESTS.throttleKey(TEST_KEY_PREFIX, tenantId);
  keysToCleanup.push(key);
  return key;
}

describe("classifyThrottle (pure)", () => {
  test("count=0 → none", () => {
    expect(classifyThrottle(0)).toBe("none");
  });

  test("count=9_999 → none (just below soft boundary)", () => {
    expect(classifyThrottle(9_999)).toBe("none");
  });

  test("count=10_000 → soft (inclusive lower bound)", () => {
    expect(classifyThrottle(10_000)).toBe("soft");
  });

  test("count=99_999 → soft (just below hard boundary)", () => {
    expect(classifyThrottle(99_999)).toBe("soft");
  });

  test("count=100_000 → hard (inclusive lower bound)", () => {
    expect(classifyThrottle(100_000)).toBe("hard");
  });

  test("count=499_999 → hard (just below emergency boundary)", () => {
    expect(classifyThrottle(499_999)).toBe("hard");
  });

  test("count=500_000 → emergency_stop (inclusive lower bound)", () => {
    expect(classifyThrottle(500_000)).toBe("emergency_stop");
  });

  test("count=1_000_000 → emergency_stop (well above all thresholds)", () => {
    expect(classifyThrottle(1_000_000)).toBe("emergency_stop");
  });

  test("default thresholds match spec §19.1 exactly", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      softMin: 10_000,
      hardMin: 100_000,
      emergencyMin: 500_000
    });
  });

  test("classifyThrottle honours custom thresholds", () => {
    const custom: ThrottleThresholds = {
      softMin: 5,
      hardMin: 100,
      emergencyMin: 1_000
    };
    expect(classifyThrottle(4, custom)).toBe("none");
    expect(classifyThrottle(5, custom)).toBe("soft");
    expect(classifyThrottle(99, custom)).toBe("soft");
    expect(classifyThrottle(100, custom)).toBe("hard");
    expect(classifyThrottle(999, custom)).toBe("hard");
    expect(classifyThrottle(1_000, custom)).toBe("emergency_stop");
  });
});

describe("measureAndPublishBackpressure", () => {
  test("writes the measured signal to Redis with the correct level and TTL", async () => {
    const tenantId = freshTenantId();
    await seedUnpublishedEvents({ tenantId, count: 5 });
    const key = trackKey(tenantId);

    const signal = await measureAndPublishBackpressure(
      { db, redis },
      { tenantId, keyPrefix: TEST_KEY_PREFIX, ttlSeconds: 30 }
    );

    expect(signal.level).toBe("none");
    expect(signal.unpublishedCount).toBe(5);
    expect(signal.alert).toBe(false);
    expect(signal.page).toBe(false);
    expect(signal.tenantId).toBe(tenantId);
    expect(signal.measuredAt).toBeInstanceOf(Date);

    // Redis got the same payload.
    const raw = await redis.get(key);
    expect(raw).not.toBeNull();
    const decoded = JSON.parse(raw!) as ThrottleSignal & { measuredAt: string };
    expect(decoded.level).toBe("none");
    expect(decoded.unpublishedCount).toBe(5);
    expect(decoded.alert).toBe(false);
    expect(decoded.page).toBe(false);
    expect(decoded.tenantId).toBe(tenantId);

    // TTL was set (and is positive). PTTL returns -2 for missing keys
    // and -1 for keys without a TTL.
    const pttl = await redis.pttl(key);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(30_000);
  });

  test("tenant scoping: tenant A's lag is not tenant B's lag", async () => {
    const tenantA = freshTenantId();
    const tenantB = freshTenantId();
    await seedUnpublishedEvents({ tenantId: tenantA, count: 5 });
    await seedUnpublishedEvents({ tenantId: tenantB, count: 5 });
    const keyA = trackKey(tenantA);
    const keyB = trackKey(tenantB);

    const sigA = await measureAndPublishBackpressure(
      { db, redis },
      { tenantId: tenantA, keyPrefix: TEST_KEY_PREFIX }
    );
    const sigB = await measureAndPublishBackpressure(
      { db, redis },
      { tenantId: tenantB, keyPrefix: TEST_KEY_PREFIX }
    );

    expect(sigA.unpublishedCount).toBe(5);
    expect(sigB.unpublishedCount).toBe(5);
    expect(sigA.tenantId).toBe(tenantA);
    expect(sigB.tenantId).toBe(tenantB);

    // Different keys, both present.
    expect(keyA).not.toBe(keyB);
    expect(await redis.exists(keyA, keyB)).toBe(2);
  });

  test("global (cross-tenant) measurement aggregates across tenants and uses _global sentinel", async () => {
    const tenantA = freshTenantId();
    const tenantB = freshTenantId();
    await seedUnpublishedEvents({ tenantId: tenantA, count: 5 });
    await seedUnpublishedEvents({ tenantId: tenantB, count: 5 });
    const globalKey = trackKey(null);

    const signal = await measureAndPublishBackpressure(
      { db, redis },
      { keyPrefix: TEST_KEY_PREFIX }
    );

    expect(signal.tenantId).toBeNull();
    // The global count includes whatever else is in the table (other
    // test tenants' leftover data, the partition seed). We assert that
    // it is AT LEAST the 10 we just inserted — never less. This is the
    // same posture poller.test.ts takes around the global TEST tenant.
    expect(signal.unpublishedCount).toBeGreaterThanOrEqual(10);

    // Key landed under the _global sentinel.
    expect(globalKey.endsWith(`:${__INTERNAL_FOR_TESTS.GLOBAL_TENANT_KEY}`)).toBe(
      true
    );
    expect(await redis.exists(globalKey)).toBe(1);
  });

  test("boundary behaviour with custom thresholds: 5 events → soft, alert=false", async () => {
    const tenantId = freshTenantId();
    await seedUnpublishedEvents({ tenantId, count: 5 });
    trackKey(tenantId);

    const signal = await measureAndPublishBackpressure(
      { db, redis },
      {
        tenantId,
        keyPrefix: TEST_KEY_PREFIX,
        thresholds: { softMin: 5, hardMin: 100, emergencyMin: 1_000 }
      }
    );

    expect(signal.unpublishedCount).toBe(5);
    expect(signal.level).toBe("soft");
    expect(signal.alert).toBe(false);
    expect(signal.page).toBe(false);
  });

  test("alert flag set on hard level (custom thresholds)", async () => {
    const tenantId = freshTenantId();
    await seedUnpublishedEvents({ tenantId, count: 5 });
    trackKey(tenantId);

    const signal = await measureAndPublishBackpressure(
      { db, redis },
      {
        tenantId,
        keyPrefix: TEST_KEY_PREFIX,
        // Force hard: 5 events into a regime where softMin=1, hardMin=5.
        thresholds: { softMin: 1, hardMin: 5, emergencyMin: 100 }
      }
    );

    expect(signal.level).toBe("hard");
    expect(signal.alert).toBe(true);
    expect(signal.page).toBe(false);
  });

  test("page flag set on emergency_stop level (custom thresholds)", async () => {
    const tenantId = freshTenantId();
    await seedUnpublishedEvents({ tenantId, count: 5 });
    trackKey(tenantId);

    const signal = await measureAndPublishBackpressure(
      { db, redis },
      {
        tenantId,
        keyPrefix: TEST_KEY_PREFIX,
        // Force emergency_stop: 5 events with all thresholds ≤ 5.
        thresholds: { softMin: 1, hardMin: 2, emergencyMin: 5 }
      }
    );

    expect(signal.level).toBe("emergency_stop");
    expect(signal.alert).toBe(true);
    expect(signal.page).toBe(true);
  });
});

describe("getCurrentThrottleLevel", () => {
  test("returns 'none' (fail-open) when no signal has been published", async () => {
    const tenantId = freshTenantId();
    trackKey(tenantId);
    // No measureAndPublishBackpressure call. Key should be absent →
    // fail-open default.
    const level = await getCurrentThrottleLevel(
      redis,
      tenantId,
      TEST_KEY_PREFIX
    );
    expect(level).toBe("none");
  });

  test("reads what measureAndPublishBackpressure wrote", async () => {
    const tenantId = freshTenantId();
    await seedUnpublishedEvents({ tenantId, count: 5 });
    trackKey(tenantId);

    await measureAndPublishBackpressure(
      { db, redis },
      {
        tenantId,
        keyPrefix: TEST_KEY_PREFIX,
        thresholds: { softMin: 5, hardMin: 100, emergencyMin: 1_000 }
      }
    );

    const level = await getCurrentThrottleLevel(
      redis,
      tenantId,
      TEST_KEY_PREFIX
    );
    expect(level).toBe("soft");
  });

  test("returns 'none' (fail-open) when stored JSON is corrupt; logger is optional", async () => {
    const tenantId = freshTenantId();
    const key = trackKey(tenantId);
    await redis.set(key, "this-is-not-json", "EX", 30);

    // No logger passed — must still fail open silently.
    const level = await getCurrentThrottleLevel(
      redis,
      tenantId,
      TEST_KEY_PREFIX
    );
    expect(level).toBe("none");
  });

  test("emits a single warn entry through the supplied logger on corrupt JSON", async () => {
    const tenantId = freshTenantId();
    const key = trackKey(tenantId);
    await redis.set(key, "not-json", "EX", 60);

    // Minimal spy: capture every `warn` call. Cast through `unknown`
    // because pino's `Logger` is a rich type; the implementation only
    // touches `.warn` on the corrupt-JSON path.
    const warnCalls: Array<{ obj: unknown; msg: unknown }> = [];
    const spyLogger = {
      info: () => {},
      warn: (obj: unknown, msg: unknown) => {
        warnCalls.push({ obj, msg });
      },
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {}
    } as unknown as Parameters<typeof getCurrentThrottleLevel>[3];

    const level = await getCurrentThrottleLevel(
      redis,
      tenantId,
      TEST_KEY_PREFIX,
      spyLogger
    );

    expect(level).toBe("none");
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.msg).toBe("catalog.outbox.backpressure_corrupt_signal");
    const obj = warnCalls[0]!.obj as { key: string; error: string };
    expect(obj.key).toBe(key);
    expect(typeof obj.error).toBe("string");
    expect(obj.error.length).toBeGreaterThan(0);
  });
});

describe("getCurrentThrottleSignal", () => {
  test("returns null when no signal has been published", async () => {
    const tenantId = freshTenantId();
    trackKey(tenantId);

    const signal = await getCurrentThrottleSignal(
      redis,
      tenantId,
      TEST_KEY_PREFIX
    );
    expect(signal).toBeNull();
  });

  test("returns the full signal payload with measuredAt rehydrated to Date", async () => {
    const tenantId = freshTenantId();
    await seedUnpublishedEvents({ tenantId, count: 5 });
    trackKey(tenantId);

    const written = await measureAndPublishBackpressure(
      { db, redis },
      { tenantId, keyPrefix: TEST_KEY_PREFIX }
    );

    const read = await getCurrentThrottleSignal(
      redis,
      tenantId,
      TEST_KEY_PREFIX
    );
    expect(read).not.toBeNull();
    expect(read!.level).toBe(written.level);
    expect(read!.unpublishedCount).toBe(written.unpublishedCount);
    expect(read!.alert).toBe(written.alert);
    expect(read!.page).toBe(written.page);
    expect(read!.tenantId).toBe(written.tenantId);
    expect(read!.measuredAt).toBeInstanceOf(Date);
    expect(read!.measuredAt.getTime()).toBe(written.measuredAt.getTime());
  });
});
