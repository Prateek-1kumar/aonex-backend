// Inventory port: per-marketplace product availability lookup. Implementations
// may read from a cache or a live proxy without changing this interface.

import type { Marketplace, MerchantId } from "@aonex/types";

export interface InventoryRecord {
  /** Provider location ID. 'default' when location is not available. */
  locationId: string;
  available: number;
  updatedAt?: Date;
}

export interface GetInventoryInput {
  merchantId: MerchantId;
  marketplace: Marketplace;
  /** Marketplace's stable product id (e.g. Shopify gid or numeric id). */
  externalProductId: string;
}

export interface IConnectorInventory {
  getInventory(input: GetInventoryInput): Promise<readonly InventoryRecord[]>;
}
