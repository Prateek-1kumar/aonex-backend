// Public surface of @aonex/db.
//
// Re-exports the `schema` namespace (all Drizzle tables), the DrizzleClient
// factory + types (client.js), and the inferred row types for attributes,
// category schemas, catalog events, tenant webhooks, and backfill cursors.
// Imported by every package that touches Postgres.

export * as schema from "./schema/index.js";
export * from "./client.js";
export type {
  AttributeDefinition,
  AttributeSynonym,
  AttributeMapping,
  MappingOverride,
} from "./schema/attributes.js";
export type { CategorySchema } from "./schema/category.js";
export type {
  CatalogEvent,
  NewCatalogEvent,
  CatalogEventDlq,
  NewCatalogEventDlq,
} from "./schema/catalog-events.js";
export type {
  TenantWebhook,
  NewTenantWebhook,
} from "./schema/tenant-webhooks.js";
export type {
  BackfillCursor,
  NewBackfillCursor,
} from "./schema/backfill-cursor.js";
