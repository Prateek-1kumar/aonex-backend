# aonex-backend

Backend monorepo for Aonex — multi-marketplace product catalog platform.

**Source of truth:** the senior's HLD,
`Aonex_Production_HLD_Catalog_Ingestion_Distribution_v2`. This codebase
implements that HLD's architecture. Internal LLDs and ADRs refine
implementation; they do not override the HLD.

See `docs/HLD-alignment.md` for the explicit mapping from HLD components
to code modules and current phase status.

## Architecture in one paragraph

Hexagonal architecture (Cockburn) with pure DI (Seemann) — no DI container,
one composition root per process. The **Connector Gateway** is the
Anti-Corruption Layer (Evans) between Nango and our domain; LSP is enforced
by a single contract test parameterized over every adapter implementation.
The HLD's 4 planes map 1:1 to package directories.

## The 4 planes (HLD §6)

| Plane | Owns | Cannot |
| --- | --- | --- |
| **Ingestion** | source_artifacts, extraction_runs, extracted_facts, mapping candidates, routing decision | Mutate approved catalog or call marketplace write APIs |
| **Catalog** | products, product_versions, variants, proposed_diffs, approvals, category schemas, channel projections | Know Nango internals or accept writes that skip proposed_diff approval |
| **Action** | sync_attempts, distribution workers, channel write results, reconciliation | Invent facts or write without a valid channel_projection |
| **Audit** | audit_events, structured logs, traces, policy decision history | Anything but append |

## Repo layout

```
aonex-backend/
├── apps/
│   ├── api/              Hono — HTTP edge, JWT, webhooks (HLD §7 "API Gateway")
│   ├── worker/           BullMQ — Phase 1 hosts ingestion + audit workers
│   └── nango/            Nango sync scripts (deployed via `nango deploy`)
├── packages/
│   ├── connector-gateway/   HLD §17 — only integration boundary
│   ├── ingestion/           Ingestion Plane (HLD §6)
│   │   ├── orchestrator/                  Phase 1 stub
│   │   ├── source-classifier/             Phase 1 stub (deterministic only V1)
│   │   ├── connector-fetcher/             Phase 1 — implemented
│   │   ├── csv-parser/                    Phase 3 stub
│   │   ├── field-extractor/               Phase 2 stub
│   │   ├── category-detector/             Phase 2 stub
│   │   ├── semantic-mapper/               Phase 2 stub
│   │   ├── variant-extractor/             Phase 2 stub
│   │   ├── deduplicator/                  Phase 2 stub
│   │   └── policy-engine/                 Phase 2 stub
│   ├── catalog/             Catalog Plane (HLD §6) — Phase 2+
│   ├── action/              Action Plane (HLD §6) — Phase 5+
│   ├── audit/               Audit Plane (HLD §6) — Phase 1
│   ├── anomaly-lab/         Phase 4
│   ├── db/                  Drizzle schema (single source of truth, all phases)
│   ├── types/               Shared types (branded IDs, errors, env)
│   ├── lib-utils/           canonicalStringify, sha256, backoff, clock
│   └── config/              ESLint + tsconfig presets
├── docs/
│   ├── adr/                 Architecture decisions (Nygard format)
│   └── HLD-alignment.md     Explicit HLD-component → code mapping
└── ...
```

**Why the empty Phase-2+ folders ship now:** so the architecture is visible
at `ls`. Each carries a README naming the phase that fills it.

## Phase 1 scope (HLD §26)

Per the HLD's Phase 1 description: tenant/merchant tables, Connector Gateway
scaffold, Nango Shopify connection, `source_artifacts`, BullMQ, audit
service. Other phases get folders + READMEs.

## Local development

```bash
# Install Bun (one-time)
curl -fsSL https://bun.sh/install | bash

# Bring up Postgres + Redis
docker compose up -d

# Install + scaffold env
bun install
cp .env.example .env

# Migrations
bun run db:push        # dev only — use migrations in CI/prod
# or
bun run db:generate
bun run db:migrate

# Dev (api + worker in parallel)
bun run dev
```

Endpoints (Phase 1):
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/connections` — opens Nango Connect handshake
- `GET  /api/connections`
- `DELETE /api/connections/:marketplace`
- `POST /api/sync/trigger`
- `POST /webhooks/nango` — HMAC-SHA256, queue-first (LLD P0-1 fix)
- `GET  /healthz`
- `GET  /readyz`

## CI gates (non-negotiable)

- `tsc -b` strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `useUnknownInCatchVariables`, `verbatimModuleSyntax`)
- ESLint with `no-restricted-imports` blocking `@nangohq/node` outside the
  gateway
- `dependency-cruiser` blocking cross-app imports and circular deps
- `bun test` — contract tests are LSP proof
- Coverage gates: 80% on apps, 95% on `packages/connector-gateway/src/contract/`

## Architecture decision records

See `docs/adr/`. Notable: ADR-001 Pure DI, ADR-002 Fat Connector Gateway,
ADR-003 HMAC-SHA256-only webhook verification, ADR-004 Nango Cloud Phase 1.
# aonex-backend
