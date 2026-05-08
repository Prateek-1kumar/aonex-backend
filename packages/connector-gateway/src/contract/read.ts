// Read port — Phase 1 surface. Maps to HLD §17:
// `capabilities`, `listRecords`, `fetchRecord`, `getSyncStatus`.

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
  /**
   * Drain helper — async-iterates pages of records. Worker uses
   * this directly to avoid manual cursor management.
   */
  drainProducts(
    input: { merchantId: MerchantId; marketplace: Marketplace },
    opts?: DrainOptions
  ): AsyncIterable<CanonicalProductRecord[]>;
  getSyncStatus(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<SyncStatus>;
}
