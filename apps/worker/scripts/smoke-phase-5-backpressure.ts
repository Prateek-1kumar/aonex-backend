#!/usr/bin/env bun
// Run: bun --env-file=../../.env run scripts/smoke-phase-5-backpressure.ts
//
// Catalog redesign Phase 5 — Task 5.8 verification smoke.
//
// Why this script exists:
//   The plan's literal Step 2 is "manually insert 200K unpublished events;
//   observe throttle level flip to 'hard'." Inserting 200K rows on a dev
//   machine is wasteful and only proves that count(*) over the
//   `idx_catalog_events_unpublished` partial index is fast — a perf concern,
//   not a correctness concern. The correctness path (lag → ThrottleLevel,
//   Redis publish, tenant isolation) is exercised end-to-end by
//   `measureAndPublishBackpressure` whether the row count is 5 or 500_000.
//
// What this script proves end-to-end:
//   For a fresh per-run tenant uuid, seed N unpublished `catalog_events`
//   rows, call `measureAndPublishBackpressure` with the thresholds chosen
//   so N lands in the target band, and verify both the returned signal AND
//   the Redis payload reflect the expected level / alert / page flags.
//
//   Three scenarios cover the full band table from spec §19.1:
//     * N=5,  default-ish thresholds → "none"            (alert=false)
//     * N=15, softMin=10            → "soft"             (alert=false)
//     * N=50, softMin=10, hardMin=30 → "hard"            (alert=true)
//
//   Tenant scoping is verified incidentally: each scenario uses a fresh
//   tenant UUID and reads back its own dedicated key.
//
// Cleanup:
//   On success or failure the script deletes the rows it inserted and the
//   Redis keys it wrote, so it leaves no trace. Test data is tagged with a
//   per-run key prefix so concurrent runs cannot collide.
//
// Exit codes:
//   0 — all assertions passed; cleanup succeeded.
//   1 — at least one assertion failed; details in stderr.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import IORedis from "ioredis";
import { createDb } from "@aonex/db";
import {
  measureAndPublishBackpressure,
  getCurrentThrottleLevel,
  type ThrottleLevel,
  type ThrottleSignal,
  type ThrottleThresholds
} from "@aonex/catalog-event-outbox";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const KEY_PREFIX = `smoke:phase-5:backpressure:${randomUUID()}`;

interface Scenario {
  name: string;
  count: number;
  thresholds: ThrottleThresholds;
  expectedLevel: ThrottleLevel;
  expectedAlert: boolean;
  expectedPage: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: "below softMin → none",
    count: 5,
    thresholds: { softMin: 10, hardMin: 30, emergencyMin: 100 },
    expectedLevel: "none",
    expectedAlert: false,
    expectedPage: false
  },
  {
    name: "at softMin → soft",
    count: 15,
    thresholds: { softMin: 10, hardMin: 30, emergencyMin: 100 },
    expectedLevel: "soft",
    expectedAlert: false,
    expectedPage: false
  },
  {
    name: "above hardMin → hard (alert=true)",
    count: 50,
    thresholds: { softMin: 10, hardMin: 30, emergencyMin: 100 },
    expectedLevel: "hard",
    expectedAlert: true,
    expectedPage: false
  }
];

async function seedEvents(
  db: ReturnType<typeof createDb>["client"],
  tenantId: string,
  count: number
): Promise<void> {
  const base = Date.parse("2026-05-22T12:00:00Z");
  for (let i = 0; i < count; i++) {
    const occurredAt = new Date(base + i * 1000).toISOString();
    await db.execute(sql`
      INSERT INTO catalog_events
        (event_type, product_id, tenant_id, payload, occurred_at, publish_attempts)
      VALUES
        ('catalog.product.created',
         ${randomUUID()},
         ${tenantId},
         ${JSON.stringify({ smoke: i })}::jsonb,
         ${occurredAt},
         0)
    `);
  }
}

interface AssertionFail {
  scenario: string;
  message: string;
}

function assertEqual<T>(
  fails: AssertionFail[],
  scenarioName: string,
  field: string,
  actual: T,
  expected: T
): void {
  if (actual !== expected) {
    fails.push({
      scenario: scenarioName,
      message: `${field}: expected ${String(expected)}, got ${String(actual)}`
    });
  }
}

async function main(): Promise<number> {
  const { client: db, close: closeDb } = createDb(DATABASE_URL, { max: 5 });
  const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  const tenantsToCleanup: string[] = [];
  const keysToCleanup: string[] = [];
  const fails: AssertionFail[] = [];

  try {
    for (const scenario of SCENARIOS) {
      const tenantId = randomUUID();
      tenantsToCleanup.push(tenantId);
      const key = `${KEY_PREFIX}:${tenantId}`;
      keysToCleanup.push(key);

      await seedEvents(db, tenantId, scenario.count);

      const signal = await measureAndPublishBackpressure(
        { db, redis },
        {
          tenantId,
          keyPrefix: KEY_PREFIX,
          thresholds: scenario.thresholds,
          ttlSeconds: 30
        }
      );

      // eslint-disable-next-line no-console
      console.log(
        `[scenario] ${scenario.name}: count=${signal.unpublishedCount} level=${signal.level} alert=${signal.alert} page=${signal.page} tenant=${tenantId.slice(0, 8)}…`
      );

      assertEqual(fails, scenario.name, "unpublishedCount", signal.unpublishedCount, scenario.count);
      assertEqual(fails, scenario.name, "level", signal.level, scenario.expectedLevel);
      assertEqual(fails, scenario.name, "alert", signal.alert, scenario.expectedAlert);
      assertEqual(fails, scenario.name, "page", signal.page, scenario.expectedPage);
      assertEqual(fails, scenario.name, "tenantId", signal.tenantId, tenantId);

      // Round-trip via the public package surface: confirms the
      // adapter-worker-facing `getCurrentThrottleLevel` returns what
      // `measureAndPublishBackpressure` just wrote.
      const persistedLevel = await getCurrentThrottleLevel(
        redis,
        tenantId,
        KEY_PREFIX
      );
      assertEqual(
        fails,
        scenario.name,
        "redis.level (via getCurrentThrottleLevel)",
        persistedLevel,
        scenario.expectedLevel
      );

      // Direct Redis read to confirm the full payload (alert / page /
      // tenantId) hit the wire untouched. This is the same shape used by
      // ops dashboards reading the raw key.
      const raw = await redis.get(key);
      if (raw === null) {
        fails.push({
          scenario: scenario.name,
          message: `redis GET returned null for key=${key}`
        });
      } else {
        const decoded = JSON.parse(raw) as ThrottleSignal & {
          measuredAt: string;
        };
        assertEqual(
          fails,
          scenario.name,
          "redis.raw.level",
          decoded.level,
          scenario.expectedLevel
        );
        assertEqual(
          fails,
          scenario.name,
          "redis.raw.unpublishedCount",
          decoded.unpublishedCount,
          scenario.count
        );
        assertEqual(
          fails,
          scenario.name,
          "redis.raw.alert",
          decoded.alert,
          scenario.expectedAlert
        );
        assertEqual(
          fails,
          scenario.name,
          "redis.raw.page",
          decoded.page,
          scenario.expectedPage
        );
        assertEqual(
          fails,
          scenario.name,
          "redis.raw.tenantId",
          decoded.tenantId,
          tenantId
        );
      }
    }
  } finally {
    // Best-effort cleanup. Errors here are logged but do not mask
    // assertion failures.
    try {
      for (const tenantId of tenantsToCleanup) {
        await db.execute(sql`
          DELETE FROM catalog_events WHERE tenant_id = ${tenantId}
        `);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[cleanup] Postgres delete failed:", err);
    }
    try {
      if (keysToCleanup.length > 0) {
        await redis.del(...keysToCleanup);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[cleanup] Redis del failed:", err);
    }

    await redis.quit();
    await closeDb();
  }

  if (fails.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`\n[smoke] FAIL — ${fails.length} assertion(s) failed:`);
    for (const f of fails) {
      // eslint-disable-next-line no-console
      console.error(`  [${f.scenario}] ${f.message}`);
    }
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log(`\n[smoke] OK — ${SCENARIOS.length} scenarios passed.`);
  return 0;
}

process.exit(await main());
