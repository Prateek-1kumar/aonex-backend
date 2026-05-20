# @aonex/connector-gateway

Anti-corruption layer between the platform and marketplace OAuth providers — routes all connection, sync, and webhook operations through a single typed gateway so callers never touch Nango or provider APIs directly.

## Exports

- `ConnectorGateway` — main façade: `createOAuthUrl`, `listProducts`, `getInventory`, `drainProducts`, `verifyAndParseWebhook`, `getSyncStatus`, etc.
- `NangoConnectorAdapter` — Nango-backed implementation of `ConnectionLifecycleAdapter`
- `ShopifyAdapter` / `NangoProxyShopifyTransport` — Shopify live adapter
- `MockConnectorAdapter` — in-memory stub for tests
- `PostgresConnectionRegistry` — DB-backed `ConnectionLookupAdapter`
- Contract types: `ConnectionDescriptor`, `CanonicalProductRecord`, `InventoryRecord`, `SyncStatus`, `TokenHealthResult`, etc.

## How it fits

Used by `apps/api` (OAuth flows, connection management) and `apps/worker` (product sync, webhook ingestion). Sits between the business layer and external marketplace APIs.

## Dependencies

- `@aonex/types`
- `@aonex/lib-utils`
- `@aonex/db`
