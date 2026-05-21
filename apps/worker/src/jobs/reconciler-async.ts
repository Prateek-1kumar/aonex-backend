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
//
// Feature-flag gated: when `useNewCatalogSchema` is false the function
// returns [] without consulting Redis or the DB — this matches the
// drain-processor / link-extract-processor dual-path conventions and keeps
// the recon queues silent until the catalog redesign is live for the deploy.

import { eq } from "drizzle-orm";
import type IORedis from "ioredis";
import type { Logger } from "pino";
import type { Worker } from "bullmq";
import { schema, type DrizzleClient } from "@aonex/db";
import { makeReconcilerWorker, reconcilerQueueName } from "@aonex/catalog-service";

/**
 * Default per-tenant Worker concurrency. Mirrors the default in
 * `makeReconcilerWorker` so the fan-out behaviour is identical whether the
 * caller is the composition root or a test instantiating workers directly.
 */
const DEFAULT_CONCURRENCY = 4;

export interface StartReconcilerWorkersDeps {
  db: DrizzleClient;
  connection: IORedis;
  logger?: Logger;
}

export interface StartReconcilerWorkersOptions {
  /**
   * Per-Worker BullMQ concurrency. Defaults to 4 (matches
   * `makeReconcilerWorker`'s default). Isolation is per-tenant — this is the
   * concurrency WITHIN one tenant's worker, not across tenants.
   */
  concurrency?: number;
  /**
   * When true (default), gates spawning behind `useNewCatalogSchema`. With
   * the flag OFF, returns [] with no observable side-effect (no DB read, no
   * Redis activity). Set to false to bypass the gate entirely — useful for
   * tests that want to exercise the discovery path without the flag.
   */
  gated?: boolean;
  /**
   * Resolved catalog-redesign feature flag value (read by the composition
   * root via `useNewCatalogSchema(env)` and forwarded here). Only consulted
   * when `gated !== false`.
   */
  useNewCatalogSchema?: boolean;
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
 *
 * Gating: when `gated !== false` AND `useNewCatalogSchema === false`, returns
 * [] without touching the DB. This is the v1 behaviour — Phase 5 will allow
 * per-tenant ramp-up.
 */
export async function startReconcilerWorkers(
  deps: StartReconcilerWorkersDeps,
  options: StartReconcilerWorkersOptions = {}
): Promise<ReconcilerWorkerHandle[]> {
  const { db, connection, logger } = deps;
  const gated = options.gated !== false;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  if (gated && options.useNewCatalogSchema === false) {
    logger?.info(
      { useNewCatalogSchema: false },
      "Reconciler workers gated by feature flag — skipping"
    );
    return [];
  }

  const activeTenants = await db
    .select({ tenantId: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.status, "active"));

  if (activeTenants.length === 0) {
    logger?.info("No active tenants — no reconciler workers spawned");
    return [];
  }

  const handles: ReconcilerWorkerHandle[] = activeTenants.map((t) => {
    const worker = makeReconcilerWorker(
      { connection, db },
      { tenantId: t.tenantId, concurrency }
    );
    logger?.info(
      {
        tenantId: t.tenantId,
        queue: reconcilerQueueName(t.tenantId),
        concurrency
      },
      "Reconciler worker spawned"
    );
    return { tenantId: t.tenantId, worker };
  });

  logger?.info(
    { count: handles.length, concurrency },
    "Reconciler workers ready"
  );
  return handles;
}
