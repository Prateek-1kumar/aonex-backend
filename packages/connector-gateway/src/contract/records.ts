// HLD §17 — types the gateway hands to Aonex business code.
// Vendor terms (Nango's `connectionId`, `providerConfigKey`,
// `_nango_metadata`) NEVER appear in these shapes.

import type { Marketplace, MerchantId } from "@aonex/types";

/** What the upstream provider can do for this connection. */
export interface ConnectorCapabilities {
  marketplace: Marketplace;
  /** Sync model names this connection supports (e.g. 'ShopifyProduct'). */
  syncs: readonly string[];
  /** True if Phase 5 write-back is supported. */
  canPublish: boolean;
}

/**
 * A normalized record fetched from a marketplace.
 * The `raw` field is intentionally unknown — adapters strip
 * `_nango_metadata` and other vendor noise before this lands in
 * Aonex business code.
 */
export interface CanonicalProductRecord {
  /** Marketplace's stable id for this product. */
  externalId: string;
  marketplace: Marketplace;
  /** Normalized record payload. Vendor noise stripped. */
  raw: Record<string, unknown>;
  /** Best-effort marketplace-side updated timestamp. */
  modifiedAt?: Date;
}

export interface RecordPage<T = CanonicalProductRecord> {
  records: readonly T[];
  /** Pagination cursor for next page. Undefined = end of stream. */
  nextCursor?: string;
}

export interface ListRecordsInput {
  merchantId: MerchantId;
  marketplace: Marketplace;
  /** Incremental drain bound — skip records modified before this. */
  modifiedAfter?: Date;
  cursor?: string;
  pageSize?: number;
}

export interface ListRecordsResult {
  page: RecordPage;
}

export interface DrainOptions {
  modifiedAfter?: Date;
  pageSize?: number;
}

export interface FetchRecordInput {
  merchantId: MerchantId;
  marketplace: Marketplace;
  externalId: string;
}

/** Sync state per HLD §16.5 — connection-level rollup. */
export interface SyncStatus {
  marketplace: Marketplace;
  lastSyncAt?: Date;
  lastSyncMode?: "INITIAL" | "INCREMENTAL" | "FULL";
  recordsAdded?: number;
  recordsUpdated?: number;
  recordsFailed?: number;
}

export interface TokenHealthResult {
  healthy: boolean;
  expiresAt?: Date;
  lastRefreshAt?: Date;
  lastError?: string;
}
