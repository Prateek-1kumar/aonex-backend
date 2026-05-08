// Worker composition root — mirrors apps/api/src/composition-root.ts
// but builds BullMQ Workers instead of HTTP routes.

import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { createDb } from "@aonex/db";
import { buildGateway } from "@aonex/connector-gateway";
import { createNangoClient } from "@aonex/connector-gateway/adapters/nango";
import { PostgresAuditEmitter } from "@aonex/audit";
import { parseEnv, QUEUE, type Env } from "@aonex/types";
import { PostgresConnectionRegistry } from "../../api/src/services/connection-registry.js";

import { makeNangoAuthProcessor } from "./processors/nango-auth.processor.js";
import { makeNangoSyncProcessor } from "./processors/nango-sync.processor.js";
import { makeDrainProcessor } from "./processors/drain.processor.js";
import { makeTriggerSyncProcessor } from "./processors/trigger-sync.processor.js";
import { WORKER_DEFAULTS } from "./lib/job-options.js";

export interface WorkerContainer {
  env: Env;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function buildContainer(env: Env): WorkerContainer {
  const logger = pino({ level: env.LOG_LEVEL });
  const db = createDb(env.DATABASE_URL, { max: 30 });
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const lookup = new PostgresConnectionRegistry(db.client);
  const gateway = buildGateway({ env, lookup });
  const audit = new PostgresAuditEmitter(db.client);

  const drainQueue = new Queue(QUEUE.NANGO_DRAIN, { connection: redis });
  const triggerQueue = new Queue(QUEUE.NANGO_TRIGGER, { connection: redis });
  const extractQueue = new Queue(QUEUE.INGESTION_EXTRACT, { connection: redis });

  // Direct Nango client for trigger-sync (no surface in gateway for triggerSync today).
  const nangoClient = createNangoClient({ secretKey: env.NANGO_SECRET_KEY, host: env.NANGO_HOST });

  const authWorker = new Worker(
    QUEUE.NANGO_AUTH,
    makeNangoAuthProcessor({ db: db.client, audit, triggerQueue }),
    { connection: redis, concurrency: WORKER_DEFAULTS.concurrency }
  );

  const syncWorker = new Worker(
    QUEUE.NANGO_SYNC,
    makeNangoSyncProcessor({ db: db.client, audit, drainQueue }),
    { connection: redis, concurrency: WORKER_DEFAULTS.concurrency }
  );

  const drainWorker = new Worker(
    QUEUE.NANGO_DRAIN,
    makeDrainProcessor({ db: db.client, audit, gateway, extractQueue }),
    {
      connection: redis,
      concurrency: 3,
      lockDuration: WORKER_DEFAULTS.drainLockDurationMs
    }
  );

  const triggerWorker = new Worker(
    QUEUE.NANGO_TRIGGER,
    makeTriggerSyncProcessor({
      client: nangoClient,
      redis,
      resolveConnectionId: async (i) => {
        const conn = await lookup.byMerchantMarketplace(i);
        return conn?.connectionId ?? null;
      }
    }),
    { connection: redis, concurrency: WORKER_DEFAULTS.concurrency }
  );

  const workers = [authWorker, syncWorker, drainWorker, triggerWorker];
  for (const w of workers) {
    w.on("completed", (job) => logger.info({ jobId: job.id, queue: w.name }, "job.completed"));
    w.on("failed", (job, err) =>
      logger.error({ jobId: job?.id, queue: w.name, err }, "job.failed")
    );
  }

  return {
    env,
    async start() {
      logger.info({ env: env.NODE_ENV }, "worker.starting");
    },
    async stop() {
      logger.info("worker.stopping");
      await Promise.all([
        authWorker.close(true),
        syncWorker.close(true),
        drainWorker.close(true),
        triggerWorker.close(true)
      ]);
      await Promise.all([drainQueue.close(), triggerQueue.close(), extractQueue.close()]);
      await redis.quit();
      await db.close();
    }
  };
}

export function buildContainerFromEnv(): WorkerContainer {
  return buildContainer(parseEnv());
}
