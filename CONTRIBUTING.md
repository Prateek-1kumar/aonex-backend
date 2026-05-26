# Contributing

This guide gets you from a fresh clone to running the system, running tests, and
making changes that pass CI. For the system model, see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Prerequisites

- **Bun** ≥ 1.1.30 — `curl -fsSL https://bun.sh/install | bash`
- **Docker** (for local Postgres + Redis)
- **Node-free:** this repo uses Bun as both package manager and runtime. Do not
  commit a `package-lock.json`/`yarn.lock`; the lockfile is `bun.lock`.

## First-time setup

```bash
docker compose up -d          # Postgres 16 + Redis 7
bun install
cp .env.example .env          # then edit — see "Environment" below
bun run db:migrate:up         # apply migrations
bun run dev                   # api + worker, watch mode
```

Verify: `curl http://localhost:8787/healthz` should return OK.

## Environment

`.env` is gitignored. Copy `.env.example` and fill in the values. The ones you
must set for a working local stack:

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection (matches `docker-compose.yml` defaults) |
| `REDIS_URL` | Redis connection |
| `JWT_SECRET` | HS256 signing secret — `openssl rand -hex 32` |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for stored tokens — `openssl rand -hex 32` (64 hex chars) |

Optional / feature-gated: `NANGO_SECRET_KEY`, `NANGO_WEBHOOK_SECRET`,
`NANGO_CONNECT_BASE_URL` (marketplace connectors); `GROQ_API_KEY` + `GROQ_*`
(LLM extraction); `INGESTION_SPINE_ENABLED` / `INGESTION_SPINE_SHADOW_MODE`
(route link-extract jobs through the newer ingestion spine);
`OTEL_EXPORTER_OTLP_ENDPOINT` (tracing). The env schema is validated at startup
by `parseEnv` in `@aonex/types` — a missing/invalid required var crashes the
process loudly, by design.

> Never commit real secrets. `.env` is ignored; keep it that way.

## Running tests

Tests are co-located `*.test.ts` files run by `bun test`, orchestrated through
Turbo.

```bash
bun run test                                   # all packages with tests
bun run test --filter=@aonex/catalog-service   # one package
cd packages/catalog/catalog-service && bun test # or run directly in a package
```

**Most tests require live infrastructure.** The majority connect to a real
Postgres + Redis (using per-test tenant UUIDs and FK-ordered cleanup), so you
must have `docker compose up -d` running and migrations applied first. Tests
that don't touch infra (e.g. `@aonex/types`) run anywhere.

Only 9 of ~41 workspaces currently have tests (see the status table in
`docs/ARCHITECTURE.md`); coverage is concentrated in the catalog core. There are
no coverage thresholds configured.

## Database changes

Schema lives in `packages/db`. To change it:

```bash
bun run db:migrate:create -- <descriptive_name>   # new SQL migration
# edit the generated file under packages/db/migrations/
bun run db:migrate:up                             # apply
bun run db:migrate:down                           # roll back the last one
```

Keep the Drizzle schema in `packages/db/src` in sync with the migration.

## Conventions enforced by the toolchain

| Check | Command | What it enforces |
| --- | --- | --- |
| Types | `bun run typecheck` | Strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). Use `import type` for type-only imports. |
| Lint | `bun run lint` | ESLint — bans `any`, bans `@nangohq/node` outside the gateway, requires switch exhaustiveness. |
| Boundaries | `bun run depcheck` | dependency-cruiser — no cross-app imports, no cycles, drizzle only in `db`, bullmq only in queues/roots. *(Currently noisy — see Known issues.)* |
| Tests | `bun run test` | `bun test` per package. |

### Code organisation

- **Domain logic depends on ports, not adapters.** Concrete adapters are wired
  in `apps/*/src/composition-root.ts` — the only place that knows concrete
  implementations.
- **All Nango/marketplace specifics go in `packages/connector-gateway`.** Other
  packages talk to it through its contract, never to `@nangohq/node`.
- **All DB access goes through `packages/db`.** `drizzle-orm` is not importable
  elsewhere.
- **API routes are thin.** Route files (`apps/api/src/routes/`) parse/validate
  input; business logic lives in `apps/api/src/handlers/` or in domain packages.

### Logging & errors

- Prefer the structured (pino) logger over `console.*`. *(The codebase is
  currently inconsistent here — new code should use the structured logger.)*
- Validate input at boundaries with zod (`parse`/`safeParse`).

## Git workflow

- Branch from `main`; open a PR.
- Keep commits focused; write a clear subject line and explain the *why* in the
  body.
- Make sure `bun run typecheck`, `bun run lint`, and `bun run test` pass for the
  code you touched. Note that two packages currently fail typecheck for
  pre-existing reasons (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) →
  Known issues) — don't let those mask new failures you introduce.
