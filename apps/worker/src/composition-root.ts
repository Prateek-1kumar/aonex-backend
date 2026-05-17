// Worker composition root — mirrors apps/api/src/composition-root.ts
// but builds BullMQ Workers instead of HTTP routes.

import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { createDb } from "@aonex/db";
import { buildGateway, PostgresConnectionRegistry } from "@aonex/connector-gateway";
import { createNangoClient } from "@aonex/connector-gateway/adapters/nango";
import { SyncService } from "./services/sync-service.js";
import { PostgresAuditEmitter } from "@aonex/audit";
import { parseEnv, QUEUE, type Env } from "@aonex/types";

import { makeNangoAuthProcessor } from "./processors/nango-auth.processor.js";
import { makeNangoSyncProcessor } from "./processors/nango-sync.processor.js";
import { makeDrainProcessor } from "./processors/drain.processor.js";
import { makeTriggerSyncProcessor } from "./processors/trigger-sync.processor.js";
import { makeLinkExtractProcessor } from "./processors/link-extract.processor.js";
import { makeIngestionSpineProcessor } from "./processors/ingestion-spine.processor.js";
import { createModelProvider, LLMProductExtractor } from "@aonex/ingestion-llm-extractor";
import { WORKER_DEFAULTS } from "./lib/job-options.js";
import { CRON_JOBS } from "./jobs/index.js";

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
  const linkExtractQueue = new Queue(QUEUE.LINK_EXTRACT, { connection: redis });
  const ingestionSpineQueue = new Queue(QUEUE.INGESTION_SPINE, { connection: redis });
  const syncService = new SyncService({ db: db.client, extractQueue });

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
    makeDrainProcessor({ db: db.client, audit, gateway, syncService }),
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

  // LLM-based link extraction worker.
  // Requires OPENAI_API_KEY env var. Falls back to a no-op if missing.
  const openaiApiKey = process.env.OPENAI_API_KEY;
  let linkExtractWorker: Worker | undefined;
  let spineWorker: Worker | undefined;
  if (openaiApiKey) {
    const providerConfig = openaiApiKey
      ? { apiKey: openaiApiKey, ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}) }
      : { apiKey: "" };
    const modelProvider = createModelProvider({
      provider: "openai",
      config: providerConfig,
    });
    const extractor = new LLMProductExtractor(modelProvider);

    linkExtractWorker = new Worker(
      QUEUE.LINK_EXTRACT,
      makeLinkExtractProcessor({ db: db.client, audit, extractor }),
      { connection: redis, concurrency: 5 }
    );

    spineWorker = new Worker(
      QUEUE.INGESTION_SPINE,
      makeIngestionSpineProcessor({ db: db.client, audit, llmExtractor: extractor }),
      { connection: redis, concurrency: 5 }
    );
  } else {
    logger.warn("OPENAI_API_KEY not set — link extraction worker disabled");
  }

  // Cron queue: schedules and dispatches periodic maintenance jobs.
  const cronQueue = new Queue("aonex.cron", { connection: redis });

  void Promise.all(
    CRON_JOBS.map((job) =>
      cronQueue.add(
        job.name,
        {},
        {
          repeat: { pattern: job.cronSchedule },
          jobId: `cron-${job.name}`,
          removeOnComplete: 50,
          removeOnFail: 100,
        }
      )
    )
  );

  const cronWorker = new Worker(
    "aonex.cron",
    async (job) => {
      const cron = CRON_JOBS.find((c) => c.name === job.name);
      if (!cron) return;
      await cron.process({ db: db.client });
    },
    { connection: redis, concurrency: 1 }
  );

  const workers = [authWorker, syncWorker, drainWorker, triggerWorker, ...(linkExtractWorker ? [linkExtractWorker] : []), ...(spineWorker ? [spineWorker] : []), cronWorker];
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
        triggerWorker.close(true),
        cronWorker.close(true),
        ...(linkExtractWorker ? [linkExtractWorker.close(true)] : []),
        ...(spineWorker ? [spineWorker.close(true)] : [])
      ]);
      await Promise.all([drainQueue.close(), triggerQueue.close(), extractQueue.close(), linkExtractQueue.close(), ingestionSpineQueue.close(), cronQueue.close()]);
      await redis.quit();
      await db.close();
    }
  };
}

export function buildContainerFromEnv(): WorkerContainer {
  return buildContainer(parseEnv());
}
