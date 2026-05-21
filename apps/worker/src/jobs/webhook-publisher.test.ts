// Tests for the webhook consumer (Task 5.7).
//
// Real Postgres + real Redis. Each test uses a unique tenant UUID,
// stream name, and consumer-group name so concurrent runs cannot collide.
// HTTP is stubbed via the `fetchImpl` DI on the consumer factory — no real
// network calls happen.

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
import type { DrizzleClient } from "@aonex/db";
import {
  makeWebhookConsumer,
  type WebhookConsumerHandle
} from "./webhook-publisher.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let db: DrizzleClient;
let redis: IORedis;

const tenantsToCleanup: string[] = [];
const streamsToCleanup: string[] = [];
const groupsToCleanup: { stream: string; group: string }[] = [];

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
  while (tenantsToCleanup.length > 0) {
    const t = tenantsToCleanup.pop()!;
    await db.execute(sql`DELETE FROM tenant_webhooks WHERE tenant_id = ${t}`);
  }
  for (const { stream, group } of groupsToCleanup) {
    try {
      await redis.xgroup("DESTROY", stream, group);
    } catch {
      // best-effort
    }
  }
  groupsToCleanup.length = 0;
  if (streamsToCleanup.length > 0) {
    await redis.del(...streamsToCleanup);
    streamsToCleanup.length = 0;
  }
});

function freshTenantId(): string {
  const id = randomUUID();
  tenantsToCleanup.push(id);
  return id;
}

function freshStreamName(): string {
  const name = `catalog.events:test:${randomUUID()}`;
  streamsToCleanup.push(name);
  return name;
}

function freshGroupName(stream: string): string {
  const group = `test-grp-${randomUUID()}`;
  groupsToCleanup.push({ stream, group });
  return group;
}

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

async function insertWebhook(args: {
  tenantId: string;
  url: string;
  eventTypes: string[];
  active?: boolean;
}): Promise<void> {
  // pg's node driver auto-binds JS arrays to text[] when the param is typed
  // explicitly via `unnest` or `ARRAY[...]`. Easiest path is to build the
  // array via ARRAY[]::text[] from individual params so each element is a
  // proper text scalar bind.
  const elements = args.eventTypes.map((t) => sql`${t}`);
  const arrayLiteral =
    elements.length === 0
      ? sql`ARRAY[]::text[]`
      : sql`ARRAY[${sql.join(elements, sql`, `)}]::text[]`;
  await db.execute(sql`
    INSERT INTO tenant_webhooks (tenant_id, url, event_types, active)
    VALUES (
      ${args.tenantId},
      ${args.url},
      ${arrayLiteral},
      ${args.active ?? true}
    )
  `);
}

interface XAddArgs {
  stream: string;
  eventId: string;
  eventType: string;
  productId: string;
  tenantId: string;
  payload: unknown;
  occurredAt?: string;
  triggeredBy?: string;
}

async function publishEvent(redis: IORedis, args: XAddArgs): Promise<string> {
  // Mirrors `serializeEventForStream` from @aonex/catalog-event-outbox.
  const fields: string[] = [
    "eventId",
    args.eventId,
    "eventType",
    args.eventType,
    "productId",
    args.productId,
    "tenantId",
    args.tenantId,
    "payload",
    JSON.stringify(args.payload),
    "triggeredBy",
    args.triggeredBy ?? "",
    "occurredAt",
    args.occurredAt ?? new Date().toISOString(),
    "publishAttempts",
    "0"
  ];
  const id = await redis.xadd(args.stream, "*", ...fields);
  return id as string;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 25
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

interface FetchCall {
  url: string;
  body: unknown;
}

interface FetchStub {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
}

/**
 * Build a fetch stub whose response per-call is taken from `responses` in
 * order. Each response is either a Response-like { status } or a thrown
 * error — `throw: <Error>`.
 */
function makeFetchStub(
  responses: ({ status: number } | { throw: Error })[]
): FetchStub {
  const calls: FetchCall[] = [];
  let i = 0;
  // The consumer only uses fetch as `(url, init) => Promise<Response>`. Bun's
  // ambient `typeof fetch` adds a `preconnect` method that the consumer never
  // calls — cast through `unknown` so the stub doesn't need to mimic it.
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const bodyStr =
      init?.body && typeof init.body === "string" ? init.body : "";
    let body: unknown = bodyStr;
    try {
      body = bodyStr ? JSON.parse(bodyStr) : undefined;
    } catch {
      /* leave as string */
    }
    calls.push({ url, body });
    const idx = Math.min(i, responses.length - 1);
    const r = responses[idx]!;
    i++;
    if ("throw" in r) throw r.throw;
    return new Response(null, { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("makeWebhookConsumer — happy path", () => {
  test("delivers a created event to a subscribed tenant webhook", async () => {
    const tenantId = freshTenantId();
    const stream = freshStreamName();
    const group = freshGroupName(stream);
    const url = "https://example.test/hook";
    await insertWebhook({
      tenantId,
      url,
      eventTypes: ["catalog.product.created"]
    });

    const eventId = String(Date.now());
    const productId = randomUUID();
    const occurredAt = new Date("2026-05-22T12:00:00Z").toISOString();
    await publishEvent(redis, {
      stream,
      eventId,
      eventType: "catalog.product.created",
      productId,
      tenantId,
      payload: { name: "Widget" },
      occurredAt
    });

    const stub = makeFetchStub([{ status: 200 }]);
    const consumer: WebhookConsumerHandle = makeWebhookConsumer(
      { db, connection: redis, logger: makeQuietLogger() },
      {
        streamName: stream,
        groupName: group,
        pollBlockMs: 100,
        fetchImpl: stub.fetchImpl,
        baseBackoffMs: 10
      }
    );
    consumer.start();
    try {
      const ok = await waitFor(() => consumer.stats().delivered === 1, 5000);
      expect(ok).toBe(true);
    } finally {
      await consumer.stop();
    }

    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]!.url).toBe(url);
    const body = stub.calls[0]!.body as Record<string, unknown>;
    expect(body.eventId).toBe(eventId);
    expect(body.eventType).toBe("catalog.product.created");
    expect(body.productId).toBe(productId);
    expect(body.tenantId).toBe(tenantId);
    expect(body.occurredAt).toBe(occurredAt);
    expect(body.payload).toEqual({ name: "Widget" });

    const stats = consumer.stats();
    expect(stats.delivered).toBe(1);
    expect(stats.failed).toBe(0);
  });
});

describe("makeWebhookConsumer — retry semantics", () => {
  test("5xx retries until success", async () => {
    const tenantId = freshTenantId();
    const stream = freshStreamName();
    const group = freshGroupName(stream);
    await insertWebhook({
      tenantId,
      url: "https://example.test/5xx",
      eventTypes: ["catalog.product.updated"]
    });

    await publishEvent(redis, {
      stream,
      eventId: String(Date.now()),
      eventType: "catalog.product.updated",
      productId: randomUUID(),
      tenantId,
      payload: {}
    });

    const stub = makeFetchStub([
      { status: 503 },
      { status: 503 },
      { status: 200 }
    ]);
    const consumer = makeWebhookConsumer(
      { db, connection: redis, logger: makeQuietLogger() },
      {
        streamName: stream,
        groupName: group,
        pollBlockMs: 100,
        fetchImpl: stub.fetchImpl,
        baseBackoffMs: 10,
        maxAttempts: 3
      }
    );
    consumer.start();
    try {
      const ok = await waitFor(() => consumer.stats().delivered === 1, 5000);
      expect(ok).toBe(true);
    } finally {
      await consumer.stop();
    }

    expect(stub.calls.length).toBe(3);
    expect(consumer.stats().delivered).toBe(1);
    expect(consumer.stats().failed).toBe(0);
  });

  test("4xx does not retry — single attempt, recorded as failed", async () => {
    const tenantId = freshTenantId();
    const stream = freshStreamName();
    const group = freshGroupName(stream);
    await insertWebhook({
      tenantId,
      url: "https://example.test/4xx",
      eventTypes: ["catalog.product.created"]
    });

    await publishEvent(redis, {
      stream,
      eventId: String(Date.now()),
      eventType: "catalog.product.created",
      productId: randomUUID(),
      tenantId,
      payload: {}
    });

    const stub = makeFetchStub([{ status: 400 }]);
    const consumer = makeWebhookConsumer(
      { db, connection: redis, logger: makeQuietLogger() },
      {
        streamName: stream,
        groupName: group,
        pollBlockMs: 100,
        fetchImpl: stub.fetchImpl,
        baseBackoffMs: 10,
        maxAttempts: 3
      }
    );
    consumer.start();
    try {
      const ok = await waitFor(() => consumer.stats().failed === 1, 5000);
      expect(ok).toBe(true);
    } finally {
      await consumer.stop();
    }

    expect(stub.calls.length).toBe(1);
    expect(consumer.stats().delivered).toBe(0);
    expect(consumer.stats().failed).toBe(1);
    expect(consumer.stats().lastErr).toBe("http_400");
  });

  test("network error retries until success", async () => {
    const tenantId = freshTenantId();
    const stream = freshStreamName();
    const group = freshGroupName(stream);
    await insertWebhook({
      tenantId,
      url: "https://example.test/net",
      eventTypes: ["catalog.product.created"]
    });

    await publishEvent(redis, {
      stream,
      eventId: String(Date.now()),
      eventType: "catalog.product.created",
      productId: randomUUID(),
      tenantId,
      payload: {}
    });

    const stub = makeFetchStub([
      { throw: new Error("ECONNRESET") },
      { status: 200 }
    ]);
    const consumer = makeWebhookConsumer(
      { db, connection: redis, logger: makeQuietLogger() },
      {
        streamName: stream,
        groupName: group,
        pollBlockMs: 100,
        fetchImpl: stub.fetchImpl,
        baseBackoffMs: 10,
        maxAttempts: 3
      }
    );
    consumer.start();
    try {
      const ok = await waitFor(() => consumer.stats().delivered === 1, 5000);
      expect(ok).toBe(true);
    } finally {
      await consumer.stop();
    }

    expect(stub.calls.length).toBe(2);
    expect(consumer.stats().delivered).toBe(1);
    expect(consumer.stats().failed).toBe(0);
  });
});

describe("makeWebhookConsumer — filtering", () => {
  test("event type outside the accepted list is skipped (no POST)", async () => {
    const tenantId = freshTenantId();
    const stream = freshStreamName();
    const group = freshGroupName(stream);
    // Webhook is configured for "merged" — but the consumer's acceptedEventTypes
    // (default) does NOT include "merged", so the consumer skips before the
    // tenant_webhooks lookup.
    await insertWebhook({
      tenantId,
      url: "https://example.test/skip",
      eventTypes: ["catalog.product.merged"]
    });

    await publishEvent(redis, {
      stream,
      eventId: String(Date.now()),
      eventType: "catalog.product.merged",
      productId: randomUUID(),
      tenantId,
      payload: {}
    });

    const stub = makeFetchStub([{ status: 200 }]);
    const consumer = makeWebhookConsumer(
      { db, connection: redis, logger: makeQuietLogger() },
      {
        streamName: stream,
        groupName: group,
        pollBlockMs: 100,
        fetchImpl: stub.fetchImpl,
        baseBackoffMs: 10
      }
    );
    consumer.start();
    try {
      const ok = await waitFor(() => consumer.stats().skipped === 1, 5000);
      expect(ok).toBe(true);
    } finally {
      await consumer.stop();
    }

    expect(stub.calls.length).toBe(0);
    expect(consumer.stats().delivered).toBe(0);
    expect(consumer.stats().failed).toBe(0);
    expect(consumer.stats().skipped).toBe(1);
  });

  test("no matching webhook → skipped (no POST)", async () => {
    const tenantId = freshTenantId(); // intentionally NO insert into tenant_webhooks
    const stream = freshStreamName();
    const group = freshGroupName(stream);

    await publishEvent(redis, {
      stream,
      eventId: String(Date.now()),
      eventType: "catalog.product.created",
      productId: randomUUID(),
      tenantId,
      payload: {}
    });

    const stub = makeFetchStub([{ status: 200 }]);
    const consumer = makeWebhookConsumer(
      { db, connection: redis, logger: makeQuietLogger() },
      {
        streamName: stream,
        groupName: group,
        pollBlockMs: 100,
        fetchImpl: stub.fetchImpl,
        baseBackoffMs: 10
      }
    );
    consumer.start();
    try {
      const ok = await waitFor(() => consumer.stats().skipped === 1, 5000);
      expect(ok).toBe(true);
    } finally {
      await consumer.stop();
    }

    expect(stub.calls.length).toBe(0);
    expect(consumer.stats().skipped).toBe(1);
    expect(consumer.stats().delivered).toBe(0);
  });
});

describe("makeWebhookConsumer — lifecycle", () => {
  test("stop() resolves cleanly even without any traffic", async () => {
    const stream = freshStreamName();
    const group = freshGroupName(stream);
    const stub = makeFetchStub([{ status: 200 }]);
    const consumer = makeWebhookConsumer(
      { db, connection: redis, logger: makeQuietLogger() },
      {
        streamName: stream,
        groupName: group,
        pollBlockMs: 100,
        fetchImpl: stub.fetchImpl,
        baseBackoffMs: 10
      }
    );
    consumer.start();
    // Let one poll happen (no traffic, BLOCK times out).
    await new Promise((r) => setTimeout(r, 150));
    await consumer.stop();
    // Idempotent second call.
    await consumer.stop();
    expect(stub.calls.length).toBe(0);
  });
});
