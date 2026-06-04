// Package entry point for @aonex/catalog-source-adapters.
//
// Re-exports the adapter types and per-adapter public APIs (csv/link/shopify),
// then registers the link, shopify-connector, and csv adapters into the registry
// at import time — the single place registration happens, so adapter modules stay
// side-effect-free. Importing this package wires up getAdapter() for all source kinds.

export * from "./types.js";
export { getAdapter, registerAdapter } from "./registry.js";
export { channelCodeFromUrl } from "./link/index.js";
export {
  channelCodeFromShopDomain,
  type ShopifyAdapterInput,
  type ShopifyProduct,
  type ShopifyVariant,
} from "./shopify-connector/index.js";
export {
  adaptGroups,
  inspectCsv,
  KNOWN_CSV_COLUMNS,
  COLUMN_ALIASES,
  type CsvAdapterInput,
  type CsvGroupResult,
  type CsvAdaptGroupsResult,
  type CsvRowIssue,
  type CsvInspectResult,
} from "./csv/index.js";

import { linkAdapter } from "./link/index.js";
import { shopifyConnectorAdapter } from "./shopify-connector/index.js";
import { csvAdapter } from "./csv/index.js";
import { registerAdapter } from "./registry.js";

registerAdapter(linkAdapter);
registerAdapter(shopifyConnectorAdapter);
registerAdapter(csvAdapter);
