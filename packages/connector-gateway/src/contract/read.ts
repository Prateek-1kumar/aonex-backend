// Read port: capabilities, record listing/fetching, paged draining, and
// sync-status for a connector.

import type {
  CanonicalProductRecord,
  ConnectorCapabilities,
  DrainOptions,
  FetchRecordInput,
  ListRecordsInput,
  ListRecordsResult,
  SyncStatus
} from "./records.js";
import type { Marketplace, MerchantId } from "@aonex/types";

export interface IConnectorRead {
  capabilities(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<ConnectorCapabilities>;
  listRecords(input: ListRecordsInput): Promise<ListRecordsResult>;
  fetchRecord(input: FetchRecordInput): Promise<CanonicalProductRecord>;
  /** Async-iterates pages of records, hiding cursor management from callers. */
  drainProducts(
    input: { merchantId: MerchantId; marketplace: Marketplace },
    opts?: DrainOptions
  ): AsyncIterable<CanonicalProductRecord[]>;
  getSyncStatus(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<SyncStatus>;
}
