// Per-tenant reconciler worker spawner — plan §4.6, spec §13.4 / §19.
//
// The async-debounced reconciler (catalog-service) uses ONE BullMQ queue PER
// tenant (`recon.<tenantId>`) so a noisy tenant can be isolated by concurrency
// profile. This module is the composition-root entry point that discovers
// active tenants at boot and spawns one Worker per tenant.
//
// Lifecycle:
//   - Called from `buildContainer` (apps/worker/src/composition-root.ts).
//   - Returns an array of handles that the container stashes; on `stop()`
//     the container calls `worker.close()` on each handle.
//
// Tenant discovery is STATIC at startup (v1). A tenant created between
// deploys won't get a worker until the next restart. Phase 5+ will add a
// dynamic discovery watcher (planned, not in this task).

import { eq } from "drizzle-orm";
import type IORedis from "ioredis";
import type { Logger } from "pino";
import type { Worker } from "bullmq";
import { schema, type DrizzleClient } from "@aonex/db";
import { makeReconcilerWorker, reconcilerQueueName } from "@aonex/catalog-service";

export interface StartReconcilerWorkersDeps {
  db: DrizzleClient;
  connection: IORedis;
  logger?: Logger;
}

export interface StartReconcilerWorkersOptions {
  /**
   * Per-Worker BullMQ concurrency. When omitted, defaults to
   * `makeReconcilerWorker`'s internal default (4). Isolation is per-tenant —
   * this is the concurrency WITHIN one tenant's worker, not across tenants.
   */
  concurrency?: number;
}

export interface ReconcilerWorkerHandle {
  tenantId: string;
  worker: Worker;
}

/**
 * Discover active tenants and spawn one reconciler Worker per tenant. Returns
 * the handles so the caller (composition root) can manage lifecycle —
 * specifically, `worker.close()` on graceful shutdown.
 *
 * Active = `tenants.status = 'active'`. Suspended/archived tenants are
 * intentionally skipped — their queues would never see traffic anyway because
 * the writer-side dual path is also tenant-aware.
 *
 * Empty tenants table (or zero active rows) is a clean no-op: returns [].
 */
export async function startReconcilerWorkers(
  deps: StartReconcilerWorkersDeps,
  options: StartReconcilerWorkersOptions = {}
): Promise<ReconcilerWorkerHandle[]> {
  const { db, connection, logger } = deps;
  const concurrency = options.concurrency;

  const activeTenants = await db
    .select({ tenantId: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.status, "active"));

  if (activeTenants.length === 0) {
    logger?.info("No active tenants — no reconciler workers spawned");
    return [];
  }

  const handles: ReconcilerWorkerHandle[] = [];
  try {
    for (const t of activeTenants) {
      // Spread concurrency only when supplied so we don't pass `undefined`
      // explicitly (tripping the downstream type's exactOptionalPropertyTypes);
      // omitting the key lets `makeReconcilerWorker`'s default (4) apply.
      const worker = makeReconcilerWorker(
        { connection, db },
        {
          tenantId: t.tenantId,
          ...(concurrency !== undefined ? { concurrency } : {}),
        }
      );
      logger?.info(
        {
          tenantId: t.tenantId,
          queue: reconcilerQueueName(t.tenantId),
          concurrency
        },
        "Reconciler worker spawned"
      );
      handles.push({ tenantId: t.tenantId, worker });
    }
  } catch (err) {
    // Don't leak partially-constructed workers (each opens a Redis subscription
    // eagerly). Close best-effort + rethrow so the caller knows startup failed.
    logger?.error(
      { err, spawned: handles.length, attempted: activeTenants.length },
      "Reconciler spawn failed mid-loop; closing partial handles"
    );
    await Promise.allSettled(handles.map((h) => h.worker.close()));
    throw err;
  }

  logger?.info(
    { count: handles.length, concurrency },
    "Reconciler workers ready"
  );
  return handles;
}
