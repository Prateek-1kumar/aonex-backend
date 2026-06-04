// Provider port for live marketplace reads — the MarketplaceLiveAdapter contract.
//
// Defines the interface every concrete adapter (Nango / Shopify / eBay) implements:
// createOAuthUrl / healthCheck / listProducts / getInventory, plus the
// ConnectionContext and ProviderProduct shapes they exchange. Product code depends
// on this port, never on a concrete provider SDK.

import type { Marketplace, MerchantId } from "@aonex/types";
import type { OAuthUrlResult, CreateOAuthUrlInput } from "./admin.js";
import type { InventoryRecord } from "./inventory.js";

export interface ConnectionContext {
  tenantId: string;
  merchantId: MerchantId;
  marketplace: Marketplace;
  connectionId: string;
}

export interface ProviderProduct {
  externalId: string;
  raw: unknown;
}

export interface ListProductsInput {
  connection: ConnectionContext;
  limit?: number;
  maxPages?: number;
}

export interface GetInventoryByConnectionInput {
  connection: ConnectionContext;
  externalProductId: string;
}

export interface MarketplaceLiveAdapter {
  createOAuthUrl(input: CreateOAuthUrlInput): Promise<OAuthUrlResult>;
  healthCheck(input: { connection: ConnectionContext }): Promise<boolean>;
  listProducts(input: ListProductsInput): Promise<ProviderProduct[]>;
  getInventory(input: GetInventoryByConnectionInput): Promise<readonly InventoryRecord[]>;
}
