// Write port — HLD §16 / Phase 5+. Defined now to lock the shape;
// implementations come later.

import type { Marketplace, MerchantId } from "@aonex/types";

export interface PublishListingInput {
  merchantId: MerchantId;
  marketplace: Marketplace;
  /** The compiled channel projection payload — pure & validated. */
  payload: Record<string, unknown>;
  /**
   * Idempotency key — same payload_hash + adapter_version yields
   * the same key. Locally enforced; reconciled if provider lacks
   * idempotency. (HLD §18.2.)
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
