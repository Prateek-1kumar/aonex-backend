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
import { makeCsvParseProcessor } from "./processors/csv-parse.processor.js";
import { makeEnrichProcessor } from "./processors/enrich.processor.js";
import { ReconcilerQueueProvider } from "./services/reconciler-queue-provider.js";
import { createModelProvider, LLMProductExtractor, NvidiaProvider, type IModelProvider } from "@aonex/ingestion-llm-extractor";
import { llmResolver, deterministicResolver, type ClassifierResolver } from "@aonex/taxonomy-classifier";
import { WORKER_DEFAULTS } from "./lib/job-options.js";
import { CRON_JOBS } from "./jobs/index.js";
import {
  startReconcilerWorkers,
  type ReconcilerWorkerHandle,
} from "./jobs/reconciler-async.js";
import { startOutboxPoller, type OutboxHandle } from "./jobs/outbox-poller.js";

export interface WorkerContainer {
  env: Env;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function buildContainer(env: Env): Promise<WorkerContainer> {
  const logger = pino({ level: env.LOG_LEVEL });

  const db = createDb(env.DATABASE_URL, { max: 30 });
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const reconcilerQueues = new ReconcilerQueueProvider(redis);

  const lookup = new PostgresConnectionRegistry(db.client);
  const gateway = buildGateway({ env, lookup });
  const audit = new PostgresAuditEmitter(db.client);
  const drainQueue = new Queue(QUEUE.NANGO_DRAIN, { connection: redis });
  const triggerQueue = new Queue(QUEUE.NANGO_TRIGGER, { connection: redis });
  const extractQueue = new Queue(QUEUE.INGESTION_EXTRACT, { connection: redis });
  const linkExtractQueue = new Queue(QUEUE.LINK_EXTRACT, { connection: redis });
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
    makeDrainProcessor({
      db: db.client,
      audit,
      gateway,
      syncService,
      logger,
      reconcilerQueues,
    }),
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
      makeLinkExtractProcessor({
        db: db.client,
        audit,
        extractor,
        reconcilerQueues,
      }),
      { connection: redis, concurrency: 5 }
    );
  } else {
    logger.warn("OPENAI_API_KEY not set — link extraction worker disabled");
  }

  // LLM provider shared by enrichment AND the taxonomy classify sweep (Groq
  // preferred, then NVIDIA). When a provider is present the sweep uses the LLM
  // resolver, so newly-ingested products get auto-categorized instead of piling
  // up uncategorized in the Lab; with no provider it falls back to deterministic.
  const groqApiKey = process.env.GROQ_API_KEY;
  const nvidiaApiKey = process.env.NVIDIA_API_KEY;
  let llmProvider: IModelProvider | undefined;
  let llmModel = "";
  if (groqApiKey) {
    llmProvider = createModelProvider({
      provider: "openai",
      config: { apiKey: groqApiKey, baseUrl: env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1" },
    });
    llmModel = process.env.GROQ_MODEL_ENRICH ?? env.GROQ_MODEL_GAP_FILL ?? "llama-3.3-70b-versatile";
  } else if (nvidiaApiKey) {
    llmProvider = new NvidiaProvider({
      apiKey: nvidiaApiKey,
      baseUrl: env.NVIDIA_BASE_URL,
      thinking: true,
      reasoningEffort: "medium",
    });
    llmModel = env.NVIDIA_MODEL_ENRICH;
  }
  const classifierResolver: ClassifierResolver = llmProvider
    ? llmResolver(llmProvider, llmModel)
    : deterministicResolver;

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
      await cron.process({ db: db.client, logger, classifierResolver });
    },
    { connection: redis, concurrency: 1 }
  );

  const csvParseWorker = new Worker(
    QUEUE.CSV_PARSE,
    makeCsvParseProcessor({ db: db.client, audit, reconcilerQueues }),
    { connection: redis, concurrency: 3 },
  );

  // Catalog enrichment worker — reuses the shared llmProvider/llmModel above.
  let enrichWorker: Worker | undefined;
  if (groqApiKey && llmProvider) {
    // Serial: Groq's on-demand TPM budget (12k) reserves prompt+max_tokens per
    // request (~9.7k each), so parallel jobs trip 429s. The provider retries
    // transient 429s with Retry-After backoff; serializing keeps us in budget.
    enrichWorker = new Worker(
      QUEUE.PRODUCT_ENRICH,
      makeEnrichProcessor({ db: db.client, provider: llmProvider, model: llmModel }),
      { connection: redis, concurrency: 1 },
    );
    logger.info({ model: llmModel }, "enrichment worker: Groq");
  } else if (nvidiaApiKey && llmProvider) {
    enrichWorker = new Worker(
      QUEUE.PRODUCT_ENRICH,
      makeEnrichProcessor({ db: db.client, provider: llmProvider, model: llmModel }),
      { connection: redis, concurrency: 2 },
    );
    logger.info({ model: llmModel }, "enrichment worker: NVIDIA DeepSeek");
  } else {
    logger.warn("No GROQ_API_KEY or NVIDIA_API_KEY — enrichment worker disabled");
  }

  const workers = [authWorker, syncWorker, drainWorker, triggerWorker, ...(linkExtractWorker ? [linkExtractWorker] : []), csvParseWorker, ...(enrichWorker ? [enrichWorker] : []), cronWorker];
  for (const w of workers) {
    w.on("completed", (job) => logger.info({ jobId: job.id, queue: w.name }, "job.completed"));
    w.on("failed", (job, err) =>
      logger.error({ jobId: job?.id, queue: w.name, err }, "job.failed")
    );
  }

  // Phase 4.6 — per-tenant reconciler workers. Discovery happens at boot;
  // new tenants between deploys won't get a worker until restart (v1).
  const reconcilerHandles: ReconcilerWorkerHandle[] = await startReconcilerWorkers(
    { db: db.client, connection: redis, logger }
  );
  for (const h of reconcilerHandles) {
    h.worker.on("completed", (job) =>
      logger.info({ jobId: job.id, queue: h.worker.name, tenantId: h.tenantId }, "job.completed")
    );
    h.worker.on("failed", (job, err) =>
      logger.error({ jobId: job?.id, queue: h.worker.name, tenantId: h.tenantId, err }, "job.failed")
    );
  }

  // Phase 5.6 — outbox poller workers + backpressure measurement interval.
  // The handle owns 4 poller worker loops + a 10s backpressure interval;
  // its `stop()` is awaited during graceful shutdown below.
  const outboxHandle: OutboxHandle | null = await startOutboxPoller(
    { db: db.client, connection: redis, logger }
  );

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
        csvParseWorker.close(true),
        ...(enrichWorker ? [enrichWorker.close(true)] : []),
        ...(linkExtractWorker ? [linkExtractWorker.close(true)] : []),
        ...reconcilerHandles.map((h) => h.worker.close(true)),
        ...(outboxHandle ? [outboxHandle.stop()] : [])
      ]);
      await Promise.all([drainQueue.close(), triggerQueue.close(), extractQueue.close(), linkExtractQueue.close(), cronQueue.close(), reconcilerQueues.close()]);
      await redis.quit();
      await db.close();
    }
  };
}

export async function buildContainerFromEnv(): Promise<WorkerContainer> {
  return buildContainer(parseEnv());
}
