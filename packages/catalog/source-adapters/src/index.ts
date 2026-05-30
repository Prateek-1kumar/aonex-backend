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
