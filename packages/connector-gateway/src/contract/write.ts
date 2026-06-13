// Write port: publish a compiled channel listing to a marketplace.

import type { Marketplace, MerchantId } from "@aonex/types";

export interface PublishListingInput {
  merchantId: MerchantId;
  marketplace: Marketplace;
  /** The compiled channel projection payload — pure & validated. */
  payload: Record<string, unknown>;
  /**
   * Idempotency key: same payload_hash + adapter_version yields the same key.
   * Enforced locally, and reconciled when the provider lacks idempotency.
   */
  idempotencyKey: string;
}

export interface PublishResult {
  success: boolean;
  externalListingId?: string;
  externalProductId?: string;
  externalVariantIds?: Record<string, string>;
  /** Channel-side validation feedback if `success: false`. */
  validationIssues?: Array<{ path: string; message: string }>;
}

export interface IConnectorWrite {
  publishListing(input: PublishListingInput): Promise<PublishResult>;
}
