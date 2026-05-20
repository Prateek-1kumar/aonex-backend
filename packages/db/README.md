# @aonex/db

Drizzle ORM client and full Postgres schema for the Aonex platform — the single source of truth for table definitions.

## Exports

- `createDb(databaseUrl, opts)` — builds a `DrizzleClient` + `Pool`; returns `{ client, pool, close }`
- `DrizzleClient` — typed Drizzle instance with all schema tables attached
- `schema` — namespace re-exporting every table: `tenants`, `merchants`, `connections`, `products`, `productVersions`, `auditEvents`, `extractionRuns`, `proposedDiffs`, and more
- `AttributeDefinition`, `AttributeSynonym`, `AttributeMapping`, `MappingOverride`, `CategorySchema` — shared schema types

## How it fits

`createDb` is called once in the composition root of `apps/api` and `apps/worker`. All other packages receive a `DrizzleClient` via dependency injection — they never construct the pool themselves.

## Dependencies

- `@aonex/types`
