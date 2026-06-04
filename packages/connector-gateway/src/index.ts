// Public API of @aonex/connector-gateway — the only sanctioned path to
// marketplace providers (ACL invariant I1: product code never imports
// @nangohq/node directly; HLD §17).
//
// Re-exports the provider contract, the factory, the concrete adapters
// (mock / Nango / Shopify / eBay), the ConnectorGateway facade, and the
// Postgres connection registry.

export * from "./contract/index.js";
export * from "./factory.js";
export { MockConnectorAdapter } from "./adapters/mock/adapter.js";
export { NangoConnectorAdapter } from "./adapters/nango/adapter.js";
export type { ConnectionLookupPort } from "./adapters/nango/adapter.js";
export { fromProviderKey, toProviderKey, SYNC_NAMES } from "./adapters/nango/provider-key.js";
export { NangoProxyShopifyTransport, ShopifyAdapter } from "./adapters/shopify/adapter.js";
export type { ShopifyTransport } from "./adapters/shopify/adapter.js";
export { NangoProxyEbayTransport, EbayAdapter } from "./adapters/ebay/adapter.js";
export type { EbayTransport, EbayAdapterConfig, NangoProxyEbayTransportConfig } from "./adapters/ebay/adapter.js";
export { ConnectorGateway } from "./gateway.js";
export type { ConnectionLifecycleAdapter, ConnectionLookupAdapter, ConnectorGatewayDeps } from "./gateway.js";
export { PostgresConnectionRegistry } from "./infra/postgres-registry.js";
