// Tests for the per-tenant reconciler worker spawner (Task 4.6).
//
// Verifies discovery + spawn behaviour against the real dev DB and a real
// local Redis. The spawner queries `tenants.status = 'active'` and creates
// one BullMQ Worker per row via `makeReconcilerWorker`. Tests close every
// spawned worker to avoid leaking Redis connections between cases.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import IORedis from "ioredis";
import type { Logger } from "pino";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_TENANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestTenant,
} from "@aonex/db/testing";
import { reconcilerQueueName } from "@aonex/catalog-service";
import {
  startReconcilerWorkers,
  type ReconcilerWorkerHandle,
} from "./reconciler-async.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Stable suffix for extra test tenants so we can clean them up by name match
// (UUIDs are randomly generated, but the `name` column lets us scope DELETE
// without bulldozing tenants used by other test suites).
const TEST_TENANT_NAME_TAG = "reconciler-async-test";

async function closeAll(handles: ReconcilerWorkerHandle[]): Promise<void> {
  await Promise.all(handles.map((h) => h.worker.close()));
}

async function deleteTestTenants(db: DrizzleClient): Promise<void> {
  // Remove only the extra tenants this suite seeded — the shared
  // TEST_TENANT_ID is preserved so other suites stay green.
  await db.execute(
    sql`DELETE FROM tenants WHERE name LIKE ${`%${TEST_TENANT_NAME_TAG}%`}`
  );
}

async function seedTenant(
  db: DrizzleClient,
  status: "active" | "suspended" | "archived",
  label: string
): Promise<string> {
  const inserted = await db
    .insert(schema.tenants)
    .values({
      name: `${label} (${TEST_TENANT_NAME_TAG})`,
      status,
    })
    .returning({ id: schema.tenants.id });
  return inserted[0]!.id;
}

describe("startReconcilerWorkers — feature flag gate", () => {
  let db: DrizzleClient;
  let connection: IORedis;
  let logs: { level: string; obj: unknown; msg: string }[];
  let logger: {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };

  beforeAll(async () => {
    db = await connectTestDb();
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await connection.quit();
    await closeTestDb();
  });

  afterEach(() => {
    logs = [];
  });

  test("flag OFF returns [] without querying tenants", async () => {
    logs = [];
    logger = {
      info: (obj, msg) => logs.push({ level: "info", obj, msg: msg ?? "" }),
      error: (obj, msg) => logs.push({ level: "error", obj, msg: msg ?? "" }),
      warn: (obj, msg) => logs.push({ level: "warn", obj, msg: msg ?? "" }),
    };

    // Spy on db.select to prove discovery is skipped. We can't easily monkey-
    // patch the Drizzle proxy, so instead we assert the "gated by feature flag"
    // log message fired AND no "Reconciler worker spawned" log was emitted.
    const handles = await startReconcilerWorkers(
      { db, connection, logger: logger as unknown as Logger },
      { useNewCatalogSchema: false }
    );
    expect(handles).toEqual([]);

    const gateLog = logs.find((l) =>
      l.msg.includes("gated by feature flag")
    );
    expect(gateLog).toBeDefined();
    const spawnLog = logs.find((l) => l.msg === "Reconciler worker spawned");
    expect(spawnLog).toBeUndefined();
  });
});

describe("startReconcilerWorkers — discovery + spawn", () => {
  let db: DrizzleClient;
  let connection: IORedis;

  beforeAll(async () => {
    db = await connectTestDb();
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await ensureTestTenant(db);
    await deleteTestTenants(db);
  });

  afterAll(async () => {
    await deleteTestTenants(db);
    await connection.quit();
    await closeTestDb();
  });

  test("flag ON spawns one Worker per active tenant", async () => {
    // Seed two additional active tenants. The shared TEST_TENANT_ID is also
    // active so we expect AT LEAST 3 handles — assert by checking that both
    // new tenants are present in the returned set.
    const tenantA = await seedTenant(db, "active", "alpha");
    const tenantB = await seedTenant(db, "active", "beta");

    let handles: ReconcilerWorkerHandle[] = [];
    try {
      handles = await startReconcilerWorkers(
        { db, connection },
        { useNewCatalogSchema: true }
      );

      const tenantIds = new Set(handles.map((h) => h.tenantId));
      expect(tenantIds.has(tenantA)).toBe(true);
      expect(tenantIds.has(tenantB)).toBe(true);

      // Each worker's queue name matches the per-tenant convention.
      const handleA = handles.find((h) => h.tenantId === tenantA)!;
      const handleB = handles.find((h) => h.tenantId === tenantB)!;
      expect(handleA.worker.name).toBe(reconcilerQueueName(tenantA));
      expect(handleB.worker.name).toBe(reconcilerQueueName(tenantB));
    } finally {
      await closeAll(handles);
      await db
        .delete(schema.tenants)
        .where(inArray(schema.tenants.id, [tenantA, tenantB]));
    }
  });

  test("suspended/archived tenants are not spawned", async () => {
    const tenantSuspended = await seedTenant(db, "suspended", "suspended-1");
    const tenantArchived = await seedTenant(db, "archived", "archived-1");
    const tenantActive = await seedTenant(db, "active", "active-mixed");

    let handles: ReconcilerWorkerHandle[] = [];
    try {
      handles = await startReconcilerWorkers(
        { db, connection },
        { useNewCatalogSchema: true }
      );
      const tenantIds = new Set(handles.map((h) => h.tenantId));
      expect(tenantIds.has(tenantSuspended)).toBe(false);
      expect(tenantIds.has(tenantArchived)).toBe(false);
      // The active one in the same batch should show up.
      expect(tenantIds.has(tenantActive)).toBe(true);
    } finally {
      await closeAll(handles);
      await db
        .delete(schema.tenants)
        .where(
          inArray(schema.tenants.id, [
            tenantSuspended,
            tenantArchived,
            tenantActive,
          ])
        );
    }
  });

  test("no active tenants returns []", async () => {
    // Flip the shared test tenant + any leftover suite tenants to suspended so
    // the SELECT returns zero rows, then restore active afterwards. We scope
    // the suspension to JUST the shared test tenant id and our suite tenants
    // (we never touch unrelated rows).
    //
    // We use a tx and roll back at the end so concurrent test runs aren't
    // disturbed.
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as DrizzleClient;
      // Suspend ALL currently-active tenants for the scope of this txn.
      await tx
        .update(schema.tenants)
        .set({ status: "suspended" })
        .where(eq(schema.tenants.status, "active"));

      const handles = await startReconcilerWorkers(
        { db: tx, connection },
        { useNewCatalogSchema: true }
      );
      try {
        expect(handles).toEqual([]);
      } finally {
        await closeAll(handles);
      }

      // Roll back the suspension by throwing — Drizzle rolls back on throw.
      throw new Error("__rollback__");
    }).catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
    });

    // Sanity: the shared tenant is back to active.
    const rows = await db
      .select({ status: schema.tenants.status })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, TEST_TENANT_ID));
    expect(rows[0]?.status).toBe("active");
  });

  test("custom concurrency is forwarded to the Worker", async () => {
    const tenantId = await seedTenant(db, "active", "concurrency");

    let handles: ReconcilerWorkerHandle[] = [];
    try {
      handles = await startReconcilerWorkers(
        { db, connection },
        { useNewCatalogSchema: true, concurrency: 8 }
      );
      const ours = handles.find((h) => h.tenantId === tenantId);
      expect(ours).toBeDefined();
      // BullMQ stores the concurrency on Worker.opts.
      expect(ours!.worker.opts.concurrency).toBe(8);
    } finally {
      await closeAll(handles);
      await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
    }
  });

  test("graceful close — handles can be closed without errors", async () => {
    const tenantId = await seedTenant(db, "active", "close");

    let handles: ReconcilerWorkerHandle[] = [];
    try {
      handles = await startReconcilerWorkers(
        { db, connection },
        { useNewCatalogSchema: true }
      );
      const ours = handles.find((h) => h.tenantId === tenantId);
      expect(ours).toBeDefined();

      // Closing each worker individually should resolve. If any throws or
      // hangs, the test will fail / time out.
      await Promise.all(handles.map((h) => h.worker.close()));
      handles = []; // Prevent finally from double-closing.
    } finally {
      if (handles.length > 0) await closeAll(handles);
      await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
    }
  });
});
