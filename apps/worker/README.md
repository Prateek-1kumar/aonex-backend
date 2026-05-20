# apps/worker

BullMQ job processor for Aonex. Handles all async work: Nango sync ingestion, LLM-based link extraction, catalog pipeline, and nightly maintenance cron jobs. Runs on Bun.

## Running locally

```bash
# From repo root — recommended (runs api + worker together)
bun run dev

# Worker only
cd apps/worker
bun run dev        # --hot reload, reads ../../.env
bun run start      # production-style, no hot reload
```

The worker connects to the same Redis and Postgres instances as the API. Both must be up before starting (`docker compose up -d` from repo root).

## Job types

### Event-driven workers (triggered by API or Nango webhooks)

| Queue (`QUEUE.*`) | Processor | Description |
| --- | --- | --- |
| `nango.auth` | `nango-auth.processor` | Handles a completed Nango OAuth connection; writes connection record, triggers initial sync |
| `nango.sync` | `nango-sync.processor` | Handles a Nango sync-complete webhook; enqueues drain job |
| `nango.drain` | `drain.processor` | Drains Nango raw sync output into `source_artifacts`; runs the catalog pipeline via `SyncService` |
| `nango.trigger` | `trigger-sync.processor` | Calls Nango's triggerSync API on demand (e.g. from `/api/sync/trigger`) |
| `link.extract` | `link-extract.processor` | Fetches a product URL, runs LLM extraction, writes `extracted_facts` — requires `OPENAI_API_KEY` |
| `ingestion.spine` | `ingestion-spine.processor` | Orchestrates multi-step ingestion pipeline for a single URL — requires `OPENAI_API_KEY` |

### Cron jobs (nightly / hourly maintenance, dispatched on `aonex.cron` queue)

| Job name | Schedule (UTC) | Description |
| --- | --- | --- |
| `price-cluster-rebuild` | Daily 02:00 | Rebuilds price clusters from approved catalog data |
| `override-promotion-scan` | Daily 02:30 | Scans for expired or promotable field overrides |
| `failure-pattern-rollup` | Daily 03:00 | Aggregates extraction failure patterns for diagnostics |
| `domain-profile-refresh` | Daily 03:30 | Refreshes per-domain scraping profiles |
| `schema-promotion-scan` | Daily 03:00 | Scans candidate schemas eligible for promotion |
| `canary-poll` | Hourly | Polls canary ingestion runs to detect regressions |
| `calibration-refit` | Weekly Sunday 04:00 | Refits LLM calibration parameters |
| `drift-scan` | Hourly | Detects catalog drift against live source data |

### One-shot scripts

| Script | Description |
| --- | --- |
| `jobs/backfill-attributes-json` | Backfills `attributes_json` column — invoke manually via `scripts/run-backfill.ts` |

## Key env vars

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | Postgres connection URL |
| `REDIS_URL` | yes | — | Redis connection URL |
| `NANGO_SECRET_KEY` | yes | — | Nango API secret key for `trigger-sync` processor |
| `NANGO_WEBHOOK_SECRET` | yes | — | Required by shared env schema |
| `NANGO_HOST` | no | `https://api.nango.dev` | Override for self-hosted Nango |
| `TOKEN_ENCRYPTION_KEY` | yes | — | 64-char lowercase hex (AES-256-GCM) |
| `OPENAI_API_KEY` | no | — | Enables `link.extract` and `ingestion.spine` workers; both are skipped if unset |
| `OPENAI_BASE_URL` | no | — | Override OpenAI endpoint (OpenRouter, Groq proxy, etc.) |
| `OPENAI_MODEL` | no | — | Model name for LLM extraction |
| `GROQ_API_KEY` | no | — | Alternative LLM provider for gap-fill and classifier paths |
| `GROQ_MODEL_GAP_FILL` | no | — | Preferred over `OPENAI_MODEL` when set |
| `PLAYWRIGHT_POOL_SIZE` | no | — | Browser fallback pool size (Phase 6) |
| `SCRAPINGBEE_API_KEY` | no | — | Enables anti-bot escalation layer (Phase 6) |
| `LOG_LEVEL` | no | `info` | pino log level |

See `packages/types/src/env.ts` for the full Zod schema.

## Architecture

The worker mirrors the API's **Composition Root** pattern: `src/composition-root.ts` is the single file that instantiates Redis, Postgres, queues, and BullMQ `Worker` instances. All other files receive dependencies via constructor arguments.

```
src/
├── composition-root.ts   Single wiring point — instantiates infra, creates all Workers
├── index.ts              Entry point — calls buildContainerFromEnv(), starts workers
├── processors/           One processor factory per queue; pure functions (makeFooProcessor)
├── services/             Domain pipeline logic split into focused modules:
│   ├── sync-service.ts              Orchestrates drain → catalog write pipeline
│   ├── catalog-persistence.ts       Writes approved facts to catalog tables
│   ├── link-catalog-pipeline.ts     Link ingestion → catalog pipeline
│   ├── payload-builder.ts           Builds structured payloads from extracted facts
│   ├── shadow-compare.ts            Compares new extraction against existing catalog entry
│   └── emit-failure-review-task.ts  Creates review tasks for failed extractions
├── jobs/                 Cron job definitions (name, schedule, process fn)
├── pipelines/            Higher-level pipeline orchestration helpers
└── lib/                  Shared worker utilities (job-options defaults, etc.)
```

**Job flow (link ingestion example):** `API POST /ingestions/link → link.extract queue → link-extract.processor → LLMProductExtractor → catalog-persistence / emit-failure-review-task`

**Job flow (Nango sync example):** `Nango webhook → API POST /webhooks/nango → nango.sync queue → nango-sync.processor → nango.drain queue → drain.processor → SyncService → catalog tables`

Workers are registered with `concurrency` defaults from `lib/job-options.ts`. The `link.extract` and `ingestion.spine` workers are only created when `OPENAI_API_KEY` is present; a warning is logged and those queues remain unprocessed otherwise.
