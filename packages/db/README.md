# @aonex/db

Drizzle ORM client and full Postgres schema for the Aonex platform — the single source of truth for table definitions.

## Exports

- `createDb(databaseUrl, opts)` — builds a `DrizzleClient` + `Pool`; returns `{ client, pool, close }`
- `DrizzleClient` — typed Drizzle instance with all schema tables attached
- `schema` — namespace re-exporting every table: `tenants`, `merchants`, `connections`, `products`, `productVersions`, `auditEvents`, `extractionRuns`, `proposedDiffs`, and more
- `AttributeDefinition`, `AttributeSynonym`, `AttributeMapping`, `MappingOverride`, `CategorySchema` — shared schema types

## How it fits

`createDb` is called once in the composition root of `apps/api` and `apps/worker`. All other packages receive a `DrizzleClient` via dependency injection — they never construct the pool themselves.

## Schema vs migrations

Two separate concerns:

- **`src/schema/*.ts`** — Drizzle table definitions, the source of truth for ORM types and query builder. Edit these whenever a table shape changes.
- **`migrations/*.sql`** — pure SQL applied to the database, executed by [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/). Edit these to actually change the DB.

Schema TS and SQL migrations must be kept in sync manually. The catalog redesign uses features Drizzle can't model (partitioned tables, `GENERATED ALWAYS AS … STORED`, `NULLS NOT DISTINCT`, custom triggers), so `drizzle-kit generate` was retired in favor of hand-written SQL.

## Migration workflow

All commands run from the repo root:

```bash
# Create a new migration (SQL file with timestamp prefix)
bun run db:migrate:create my_migration_name

# Apply all pending migrations
bun run db:migrate:up

# Roll back the most recent migration
bun run db:migrate:down

# Pass-through to the underlying CLI for flags like --dry-run, --fake, --count
bun --cwd packages/db run migrate up --dry-run
```

Migrations live in `packages/db/migrations/` and are applied in filename order. `node-pg-migrate` tracks applied migrations in the `pgmigrations` table.

### Conventions

- **Filename:** numeric prefix + snake_case name, e.g. `0010_add_pricing_observations.sql`. Use the next free number after the highest existing prefix.
- **Up only by default.** `node-pg-migrate` treats the whole file as the up direction. Add a `-- Down Migration` section if rollback matters for that change.
- **One concern per migration.** Don't mix unrelated DDL — keeps rollback and review surgical.
- **No `--> statement-breakpoint`** markers needed. They were Drizzle artifacts; SQL comments either way.
- **Transactional by default.** `node-pg-migrate` wraps each migration in a transaction. For DDL that can't run in a transaction (e.g. `CREATE INDEX CONCURRENTLY`), use a JS migration with `pgm.noTransaction()` instead of SQL.

### Bootstrapping a fresh DB

```bash
createdb -h localhost -U aonex aonex_dev
bun run db:migrate:up
```

This applies every migration in order. CI does this for ephemeral test DBs.

## Drizzle Studio

```bash
bun run db:studio
```

Reads from `drizzle.config.ts` — connects to whatever DB `DATABASE_URL` points at and shows live schema. No migration tracking; pure inspection.

## Dependencies

- `@aonex/types`
