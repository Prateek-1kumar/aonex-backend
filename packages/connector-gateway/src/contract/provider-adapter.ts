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
