// Inventory port — Phase 1 reads from Nango-cached product variants.
// Phase 2+ can swap to a live proxy call without changing this interface.

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
