# Architecture

Aonex is a multi-marketplace product-catalog platform. This document describes
how the backend is structured, what each piece does, and — importantly — which
packages are **live** versus **planned placeholders**, so you can tell real code
from scaffolding at a glance.

## Design principles

- **Hexagonal architecture with pure dependency injection.** No DI container;
  each process (`api`, `worker`) has a single composition root
  (`apps/*/src/composition-root.ts`) that wires concrete adapters to ports.
- **The Connector Gateway is an Anti-Corruption Layer.** All marketplace/Nango
  specifics are isolated in `packages/connector-gateway`; the rest of the domain
  never imports `@nangohq/node` directly.
- **Strict TypeScript everywhere** (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- **Workspace packages export their `src/*.ts` directly** (no pre-build step for
  intra-repo consumption); Bun runs the TypeScript sources.

## The four planes

The domain is divided into four planes with strict ownership boundaries:

| Plane | Owns | Must not |
| --- | --- | --- |
| **Ingestion** | source artifacts, extraction runs, extracted facts, mapping candidates, routing decisions | mutate the approved catalog or call marketplace write APIs |
| **Catalog** | products, versions, variants, proposed diffs, approvals, category schemas, channel projections | know Nango internals, or accept writes that skip proposed-diff approval |
| **Action** | sync attempts, distribution workers, channel write results, reconciliation | invent facts, or write without a valid channel projection |
| **Audit** | audit events, structured logs, traces, policy-decision history | do anything but append |

## Applications (`apps/`)

| App | Package | Role |
| --- | --- | --- |
| **api** | `@aonex/api` | Hono HTTP edge. Routes: `auth`, `signup`, `google-auth`, `connections`, `shopify`, `ebay`, `sync`, `catalog`, `anomaly-lab`, `ingestions`, `review`, `webhooks` (HMAC-verified), `health`, `swagger`. |
| **worker** | `@aonex/worker` | BullMQ processors + nightly cron jobs: `reconciler-async`, `outbox-poller`, `webhook-publisher`, `drift-scan`, `calibration-refit`, `canary-poll`, `domain-profile-refresh`, `failure-pattern-rollup`, `override-promotion-scan`, `price-cluster-rebuild`, `schema-promotion-scan`, `link-trace-cleanup`. |
| **nango** | `nango-integrations` | Nango sync scripts, deployed separately via `nango deploy`. |

## Packages (`packages/`)

Status legend:
- **Live** — real implementation, imported and used at runtime.
- **Stub** — a ~2-line `export const PHASE …` placeholder shipped so the
  intended architecture is visible at `ls`; not yet built.
- **Orphan** — contains real code but is currently imported by nothing; present
  in the tree but not wired into a running app.

> This table is the **source of truth for package status**. Some individual
> package `README.md` files still carry older "Phase N stub" labels that no
> longer match reality — trust this table over those.

### Shared / infrastructure

| Package | Status | ~LOC | Notes |
| --- | --- | --- | --- |
| `@aonex/db` | Live | 2346 | Drizzle schema (single source of truth) + migrations (`node-pg-migrate`). 11 test files. |
| `@aonex/types` | Live | 484 | Branded IDs, error types, zod env schema (`parseEnv`). |
| `@aonex/lib-utils` | Live | 249 | `canonicalStringify`, `sha256`, `backoff`, clock. |
| `@aonex/connector-gateway` | Live | 1890 | Anti-Corruption Layer for Nango/marketplaces. 3 test files. |
| `config` | Live | — | Shared ESLint + tsconfig presets. |

### Ingestion plane

Note the **two coexisting roots** (see "Known issues" below):

**Nested `packages/ingestion/*` (original Phase 1–3 design):**

| Package | Status | ~LOC |
| --- | --- | --- |
| `@aonex/ingestion-structured` | Live | 2628 |
| `@aonex/ingestion-llm-extractor` | Live | 1395 |
| `@aonex/ingestion-policy-engine` | Live | 600 |
| `@aonex/ingestion-enrichment` | Live | 534 |
| `@aonex/ingestion-link-fetcher` | Live | 497 |
| `@aonex/ingestion-semantic-mapper` | Live | 400 |
| `@aonex/ingestion-field-extractor` | Live | 316 |
| `@aonex/ingestion-variant-extractor` | Live | 221 |
| `@aonex/ingestion-deduplicator` | Live | 199 |
| `@aonex/ingestion-category-detector` | Live | 110 |
| `@aonex/ingestion-orchestrator` | **Stub** | 2 |
| `@aonex/ingestion-source-classifier` | **Stub** | 2 |
| `@aonex/ingestion-connector-fetcher` | **Stub** | 2 |
| `@aonex/ingestion-csv-parser` | **Stub** | 2 |

**Flat `packages/ingestion-*` (later "spine" redesign):**

| Package | Status | ~LOC |
| --- | --- | --- |
| `@aonex/ingestion-spine` | Live | 932 |
| `@aonex/ingestion-dom-heuristics` | Live | 485 |
| `@aonex/ingestion-browser-fallback` | Live | 242 |
| `@aonex/ingestion-antibot-vendor` | Live | 144 |

**Related (link/scrape extraction):**

| Package | Status | ~LOC |
| --- | --- | --- |
| `@aonex/link-adapter` | Live | 783 |
| `@aonex/per-site-parsers` | Live | 657 |
| `@aonex/vision-extractor` | Live | 274 |

### Catalog plane

| Package | Status | ~LOC | Notes |
| --- | --- | --- | --- |
| `@aonex/catalog-service` | Live | 5572 | Core merge/split/version logic. 18 test files (the most-tested package). |
| `@aonex/catalog-source-adapters` | Live | 1524 | 5 test files. |
| `@aonex/catalog-event-outbox` | Live | 1480 | Outbox/DLQ + backpressure. 4 test files. |
| `@aonex/catalog-watchdog` | Live | 1071 | Selector-drift detection. 5 test files. |
| `@aonex/multi-source-reconciler` | Live | 252 | Winner-picking across sources. |
| `@aonex/drift-detector` | Live | 217 | Statistical (PSI / null-rate) drift. *(Distinct from watchdog's selector drift.)* |
| `@aonex/calibration` | Live | 151 | Confidence calibration. |
| `@aonex/schema-validator` | Live | 111 | Library-only canonical-schema validation. |
| `@aonex/selector-health` | **Orphan** | 96 | Real code, but no internal importers found. |

### Action plane

| Package | Status | ~LOC |
| --- | --- | --- |
| `@aonex/action-projection-compiler` | **Stub** | 2 |
| `@aonex/action-distribution-worker` | **Stub** | 2 |

### Audit plane

| Package | Status | ~LOC | Notes |
| --- | --- | --- | --- |
| `@aonex/audit` | Live | 74 | Append-only audit emitter. Used widely; currently has no tests. |
| `@aonex/observability-views` | **Orphan** | 109 | Real code, but no internal importers found. |

## Data stores

- **PostgreSQL 16** — primary store. Schema and 24 ordered migrations
  (`0000`–`0023`) live in `packages/db` (`src/` + `migrations/`), applied with
  `node-pg-migrate`.
- **Redis 7** — BullMQ queues and the outbox poller.

## Enforced boundaries

`.dependency-cruiser.cjs` defines these rules (also mirrored in ESLint where
applicable):

- `no-cross-app-imports` — apps must not import each other's internals.
- `no-circular` — no circular dependencies.
- `no-orphans` — flags packages nothing imports.
- `nango-only-in-gateway` — `@nangohq/node` only inside
  `packages/connector-gateway/src/adapters/nango/`.
- `drizzle-only-in-db` — `drizzle-orm` only inside `packages/db`.
- `bullmq-only-in-queues-and-roots` — `bullmq` only in composition roots and the
  worker.

## Known issues (as of this writing)

These predate the documentation work and are tracked for a follow-up phase:

1. **`bun run typecheck` fails in two packages** (pre-existing, unrelated to
   each other):
   - `@aonex/api` — real type errors (`@aonex/types` has no exported `Clock`;
     several Hono route-handler overload mismatches in `sync`/`shopify`/
     `connections`; type issues in `handlers/review.ts`).
   - `@aonex/ingestion-variant-extractor` — a tsconfig mis-wiring: it imports
     `@aonex/ingestion-semantic-mapper`, which exports its raw `./src/*.ts`
     sources, pulling them outside variant-extractor's `rootDir` (TS6059/TS6307).
     Fix by giving these packages proper project references (or relaxing
     `rootDir`).
   The other 67 packages type-check cleanly.

2. **`bun run depcheck` reports false violations.** It scans stale `dist/` build
   output (gitignored, but present locally after a build), and the
   `no-cross-app-imports` rule currently misfires on *intra*-app imports (e.g.
   `apps/worker/src/jobs/index.ts` importing its sibling jobs). Reconfigure
   before relying on it as a gate.

3. **Two ingestion roots coexist** (nested `packages/ingestion/*` and flat
   `packages/ingestion-*`) — two generations of the ingestion design.
   Consolidation is pending; until then, the flat `ingestion-spine` packages are
   the newer path.

4. **Test coverage is concentrated** in the catalog core. Only 9 of ~41
   workspaces have tests; most run against live Postgres + Redis (see
   `CONTRIBUTING.md`).
