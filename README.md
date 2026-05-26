# aonex-backend

Backend monorepo for **Aonex**, a multi-marketplace product-catalog platform.
It ingests product data from marketplace connectors (Shopify, eBay via Nango),
CSV uploads, and product links (web scraping); maps it into a canonical
catalog; reconciles data across sources; gates every change through a
staging/approval flow (the "anomaly lab"); and distributes approved products to
channels.

The architecture follows a hexagonal / pure-DI design organised into four
planes (Ingestion → Catalog → Action → Audit). See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full model, the
apps/packages map, and the authoritative **what's-built-vs-planned** table.

> **New here?** Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
> system model and [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, workflow, and
> the conventions this repo enforces.

## Tech stack

- **Runtime:** [Bun](https://bun.sh) (≥ 1.1.30)
- **Monorepo:** Turborepo workspaces — `apps/*` + `packages/*` (and the nested
  `packages/ingestion/*`, `packages/catalog/*`, `packages/action/*`)
- **HTTP:** [Hono](https://hono.dev) (`apps/api`)
- **Jobs/cron:** [BullMQ](https://docs.bullmq.io) on Redis (`apps/worker`)
- **DB:** PostgreSQL 16 + [Drizzle ORM](https://orm.drizzle.team), migrations
  via `node-pg-migrate` (`packages/db`)
- **External connectors:** [Nango](https://www.nango.dev) (`apps/nango` +
  `packages/connector-gateway`)
- **Language:** TypeScript in strict mode throughout

## Quick start

```bash
# 1. Install Bun (one-time)
curl -fsSL https://bun.sh/install | bash

# 2. Bring up Postgres + Redis
docker compose up -d

# 3. Install deps and create your env file
bun install
cp .env.example .env
#    then edit .env — at minimum set JWT_SECRET and TOKEN_ENCRYPTION_KEY:
#    openssl rand -hex 32

# 4. Run database migrations
bun run db:migrate:up

# 5. Start the API + worker in parallel
bun run dev
```

The API listens on `http://localhost:8787` (`GET /healthz`, `GET /readyz`).

## Common commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Run `api` + `worker` in watch mode (parallel) |
| `bun run build` | `tsc -b` across all packages |
| `bun run typecheck` | Type-check every package |
| `bun run lint` | ESLint across all packages *(currently broken — needs ESLint flat-config migration; see docs/ARCHITECTURE.md)* |
| `bun run test` | Run the test suites (needs Postgres + Redis up — see CONTRIBUTING) |
| `bun run depcheck` | dependency-cruiser boundary check |
| `bun run db:migrate:up` | Apply pending migrations |
| `bun run db:migrate:down` | Roll back the last migration |
| `bun run db:migrate:create -- <name>` | Create a new SQL migration |
| `bun run db:studio` | Open Drizzle Studio |

## Repo layout

```
aonex-backend/
├── apps/
│   ├── api/      Hono HTTP edge — auth, connections, catalog, anomaly-lab, webhooks
│   ├── worker/   BullMQ processors + nightly cron jobs (reconciler, drift scan, …)
│   └── nango/    Nango sync scripts (deployed via `nango deploy`)
├── packages/     ~38 workspaces across the 4 planes (see docs/ARCHITECTURE.md)
├── docs/
│   ├── ARCHITECTURE.md   System model + package status table
│   └── runbooks/         Operational runbooks (cutover, backfill, manual split)
├── docker-compose.yml    Local Postgres 16 + Redis 7
└── CONTRIBUTING.md        Setup, workflow, and enforced conventions
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the 4-plane model, apps,
  package inventory, and current build status.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — environment setup, running tests, and
  the conventions enforced in CI (import boundaries, strict TS).
- [`docs/runbooks/`](docs/runbooks/) — operational procedures.
- [`docs/superpowers/`](docs/superpowers/) — design specs and implementation
  plans for recent features.
