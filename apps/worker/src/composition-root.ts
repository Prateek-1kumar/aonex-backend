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
import { selectEnrichChain, FallbackChatProvider, type ChatProvider } from "@aonex/lib-utils";

import { makeNangoAuthProcessor } from "./processors/nango-auth.processor.js";
import { makeNangoSyncProcessor } from "./processors/nango-sync.processor.js";
import { makeDrainProcessor } from "./processors/drain.processor.js";
import { makeTriggerSyncProcessor } from "./processors/trigger-sync.processor.js";
import { makeLinkExtractProcessor } from "./processors/link-extract.processor.js";
import { makeCsvParseProcessor } from "./processors/csv-parse.processor.js";
import { makeEnrichProcessor } from "./processors/enrich.processor.js";
import { ReconcilerQueueProvider } from "./services/reconciler-queue-provider.js";
import { makeCategoryClassifier } from "./services/category-classifier.js";
import { createModelProvider, LLMProductExtractor, type IModelProvider } from "@aonex/ingestion-llm-extractor";
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

  // LLM provider shared by link extraction, enrichment AND the taxonomy classify
  // sweep (Groq). When present the spine auto-categorizes at ingestion and the
  // sweep uses the LLM resolver, so products don't pile up uncategorized in the
  // Lab; with no key both fall back to deterministic.
  // Groq enforces token-per-day limits PER MODEL, so when the primary enrich
  // model's daily budget is exhausted (a real cause of "enrichment stuck"), the
  // provider transparently falls back to this model (independent TPD budget)
  // instead of failing. 8b-instant has a much larger daily allowance.
  const groqFallbackModels = [process.env.GROQ_MODEL_FALLBACK ?? "llama-3.1-8b-instant"];
  // Enrichment provider chain: Gemini → Groq → OpenAI (shared rule with the
  // enrichment eval via @aonex/lib-utils). The classifier sweep uses the PRIMARY
  // provider; enrichment uses a FallbackChatProvider so a primary 429 (e.g. Gemini
  // quota) transparently fails over to the next provider mid-request.
  const enrichChain = selectEnrichChain(process.env);
  let llmProvider: IModelProvider | undefined; // primary — classifier sweep
  let enrichProvider: ChatProvider | undefined; // chain w/ runtime failover — enrichment
  let llmModel = "";
  if (enrichChain.length > 0) {
    const links = enrichChain.map((s) => ({
      provider: createModelProvider({
        provider: "openai",
        config: { apiKey: s.apiKey, baseUrl: s.baseUrl, fallbackModels: s.fallbackModels },
      }),
      model: s.model,
      label: s.provider,
    }));
    llmProvider = links[0]!.provider;
    llmModel = enrichChain[0]!.model;
    enrichProvider = links.length === 1 ? links[0]!.provider : new FallbackChatProvider(links);
  }
  const classifierResolver: ClassifierResolver = llmProvider
    ? llmResolver(llmProvider, llmModel)
    : deterministicResolver;

  // Spine taxonomy classifier — resolves a canonical category node at ingestion
  // so clean products admit pre-categorized (and enrich-ready) instead of
  // stalling in the Lab. Shares the resolver above; the index is cached.
  const categoryClassifier = makeCategoryClassifier(db.client, classifierResolver);

  // LLM-based link extraction worker.
  // Requires OPENAI_API_KEY env var. Falls back to a no-op if missing.
  const openaiApiKey = process.env.OPENAI_API_KEY;
  let linkExtractWorker: Worker | undefined;
  if (openaiApiKey) {
    // When OPENAI_BASE_URL points at Groq, the same per-model TPD fallback
    // applies to gap-fill extraction too.
    const usingGroq = (process.env.OPENAI_BASE_URL ?? "").includes("groq");
    const providerConfig = openaiApiKey
      ? {
          apiKey: openaiApiKey,
          ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
          ...(usingGroq ? { fallbackModels: groqFallbackModels } : {}),
        }
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
        classifyCategory: categoryClassifier,
      }),
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
      await cron.process({ db: db.client, logger, classifierResolver });
    },
    { connection: redis, concurrency: 1 }
  );

  const csvParseWorker = new Worker(
    QUEUE.CSV_PARSE,
    makeCsvParseProcessor({ db: db.client, audit, reconcilerQueues }),
    { connection: redis, concurrency: 3 },
  );

  // Catalog enrichment worker — uses the failover chain (enrichProvider) above.
  let enrichWorker: Worker | undefined;
  if (enrichProvider) {
    // Serial: Groq's on-demand TPM budget (12k) reserves prompt+max_tokens per
    // request (~9.7k each), so parallel jobs trip 429s. The provider retries
    // transient 429s with Retry-After backoff; serializing keeps us in budget.
    // (DeepSeek has no such TPM wall, but serial is still a safe default.)
    enrichWorker = new Worker(
      QUEUE.PRODUCT_ENRICH,
      makeEnrichProcessor({ db: db.client, provider: enrichProvider, model: llmModel }),
      { connection: redis, concurrency: 1 },
    );
    logger.info(
      { model: llmModel, chain: enrichChain.map((s) => s.provider).join("→") },
      "enrichment worker: enabled"
    );
  } else {
    logger.warn("No GEMINI_API_KEY / GROQ_API_KEY — enrichment worker disabled");
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
