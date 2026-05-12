// NangoConnectorAdapter — implements the HLD §17 ConnectorAdapter
// surface against Nango Cloud.
//
// Phase 1: read + admin + webhook (Read + Admin + Verifier ports).
// Phase 5+: write (publishListing).

import type {
  ConnectorAdapterPhase1,
  ConnectorCapabilities,
  ConnectionDescriptor,
  ConnectSessionToken,
  CreateConnectSessionInput,
  CanonicalProductRecord,
  DrainOptions,
  FetchRecordInput,
  ListRecordsInput,
  ListRecordsResult,
  SyncStatus,
  TokenHealthResult,
  VerifyAndParseInput,
  VerifyAndParseResult,
  OAuthUrlResult,
  CreateOAuthUrlInput,
  GetInventoryInput,
  InventoryRecord
} from "../../contract/index.js";
import type {
  ConnectionId,
  Marketplace,
  MerchantId,
  TenantId
} from "@aonex/types";
import { GatewayError } from "@aonex/types";

import type { NangoClient } from "./client.js";
import { mapNangoError } from "./error-map.js";
import { fromProviderKey, SYNC_NAMES, toProviderKey } from "./provider-key.js";
import { normalizerFor } from "./normalize/index.js";
import { verifyAndParseWebhook } from "./webhook-verify.js";

/** Lookup port — implemented by the API/worker over `marketplace_connections`. */
export interface ConnectionLookupPort {
  byMerchantMarketplace(input: {
    merchantId: MerchantId;
    marketplace: Marketplace;
  }): Promise<{ tenantId: TenantId; connectionId: ConnectionId } | null>;
  listByMerchant(input: { merchantId: MerchantId }): Promise<readonly ConnectionDescriptor[]>;
}

export interface NangoConnectorAdapterDeps {
  client: NangoClient;
  lookup: ConnectionLookupPort;
  webhookSecret: string;
  webhookSecretNext?: string;
  nowMs?: () => number;
}

// Captures only the Nango SDK methods we actually invoke.
// The single cast happens here so every call-site stays clean.
interface NangoClientCompat {
  createConnectSession(args: {
    end_user: { id: string };
    allowed_integrations: string[];
  }): Promise<{ data: { token: string; expires_at: string } }>;

  listRecords(args: {
    providerConfigKey: string;
    connectionId: string;
    model: string;
    modifiedAfter?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ records: Array<Record<string, unknown>>; next_cursor?: string }>;

  getSyncStatus(args: {
    providerConfigKey: string;
    connectionId: string;
    syncs: string[];
  }): Promise<{
    syncs: Array<{
      latest_sync?: {
        result?: { added: number; updated: number; deleted: number };
        updated_at?: string;
      };
      sync_type?: "INITIAL" | "INCREMENTAL" | "FULL";
    }>;
  }>;

  deleteConnection(args: { providerConfigKey: string; connectionId: string }): Promise<void>;

  getConnection(args: { providerConfigKey: string; connectionId: string }): Promise<{
    credentials?: { expires_at?: string };
    updated_at?: string;
    last_error?: string;
  }>;
}

export class NangoConnectorAdapter implements ConnectorAdapterPhase1 {
  private readonly client: NangoClientCompat;

  constructor(private readonly deps: NangoConnectorAdapterDeps) {
    this.client = deps.client as unknown as NangoClientCompat;
  }

  // -------- Read --------------------------------------------------

  async capabilities(input: {
    merchantId: MerchantId;
    marketplace: Marketplace;
  }): Promise<ConnectorCapabilities> {
    return {
      marketplace: input.marketplace,
      syncs: SYNC_NAMES[input.marketplace],
      canPublish: false
    };
  }

  async listRecords(input: ListRecordsInput): Promise<ListRecordsResult> {
    const conn = await this.requireConnection(input.merchantId, input.marketplace);
    const provider = toProviderKey(input.marketplace);
    const model = SYNC_NAMES[input.marketplace][0];
    if (!model) {
      throw new GatewayError("validation_failed", `No sync model for ${input.marketplace}`);
    }
    try {
      const res = await this.client.listRecords({
        providerConfigKey: provider,
        connectionId: conn.connectionId,
        model,
        ...(input.modifiedAfter ? { modifiedAfter: input.modifiedAfter.toISOString() } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.pageSize ? { limit: input.pageSize } : {})
      });
      const normalize = normalizerFor(input.marketplace);
      return {
        page: {
          records: res.records.map((r) => normalize(r, { marketplace: input.marketplace })),
          ...(res.next_cursor ? { nextCursor: res.next_cursor } : {})
        }
      };
    } catch (err) {
      throw mapNangoError(err);
    }
  }

  async fetchRecord(input: FetchRecordInput): Promise<CanonicalProductRecord> {
    throw new GatewayError("validation_failed", "fetchRecord not implemented in Phase 1");
  }

  async *drainProducts(
    input: { merchantId: MerchantId; marketplace: Marketplace },
    opts: DrainOptions = {}
  ): AsyncIterable<CanonicalProductRecord[]> {
    let cursor: string | undefined;
    while (true) {
      const result = await this.listRecords({
        merchantId: input.merchantId,
        marketplace: input.marketplace,
        ...(opts.modifiedAfter ? { modifiedAfter: opts.modifiedAfter } : {}),
        ...(opts.pageSize ? { pageSize: opts.pageSize } : {}),
        ...(cursor ? { cursor } : {})
      });
      if (result.page.records.length > 0) {
        yield [...result.page.records];
      }
      if (!result.page.nextCursor) break;
      cursor = result.page.nextCursor;
    }
  }

  async getSyncStatus(input: {
    merchantId: MerchantId;
    marketplace: Marketplace;
  }): Promise<SyncStatus> {
    const conn = await this.requireConnection(input.merchantId, input.marketplace);
    try {
      const provider = toProviderKey(input.marketplace);
      const status = await this.client.getSyncStatus({
        providerConfigKey: provider,
        connectionId: conn.connectionId,
        syncs: SYNC_NAMES[input.marketplace] as string[]
      });
      const first = status.syncs[0];
      const result: SyncStatus = { marketplace: input.marketplace };
      if (first?.latest_sync?.updated_at) {
        result.lastSyncAt = new Date(first.latest_sync.updated_at);
      }
      if (first?.sync_type) {
        result.lastSyncMode = first.sync_type;
      }
      if (first?.latest_sync?.result) {
        result.recordsAdded = first.latest_sync.result.added;
        result.recordsUpdated = first.latest_sync.result.updated;
        result.recordsFailed = first.latest_sync.result.deleted;
      }
      return result;
    } catch (err) {
      throw mapNangoError(err);
    }
  }

  // -------- Admin -------------------------------------------------

  async createConnectSession(input: CreateConnectSessionInput): Promise<ConnectSessionToken> {
    try {
      const res = await this.client.createConnectSession({
        end_user: { id: input.merchantId },
        allowed_integrations: input.marketplaces.map(toProviderKey)
      });
      return { token: res.data.token, expiresAt: new Date(res.data.expires_at) };
    } catch (err) {
      throw mapNangoError(err);
    }
  }

  async getConnection(input: {
    merchantId: MerchantId;
    marketplace: Marketplace;
  }): Promise<ConnectionDescriptor | null> {
    const list = await this.deps.lookup.listByMerchant({ merchantId: input.merchantId });
    return list.find((c) => c.marketplace === input.marketplace) ?? null;
  }

  async listConnections(input: {
    merchantId: MerchantId;
  }): Promise<readonly ConnectionDescriptor[]> {
    return this.deps.lookup.listByMerchant({ merchantId: input.merchantId });
  }

  async revoke(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<void> {
    const conn = await this.requireConnection(input.merchantId, input.marketplace);
    try {
      await this.client.deleteConnection({
        providerConfigKey: toProviderKey(input.marketplace),
        connectionId: conn.connectionId
      });
    } catch (err) {
      throw mapNangoError(err);
    }
  }

  async refreshTokenHealth(input: {
    connectionId: ConnectionId;
    marketplace: Marketplace;
  }): Promise<TokenHealthResult> {
    try {
      const conn = await this.client.getConnection({
        providerConfigKey: toProviderKey(input.marketplace),
        connectionId: input.connectionId
      });
      const result: TokenHealthResult = { healthy: !conn.last_error };
      if (conn.credentials?.expires_at) {
        result.expiresAt = new Date(conn.credentials.expires_at);
      }
      if (conn.updated_at) {
        result.lastRefreshAt = new Date(conn.updated_at);
      }
      if (conn.last_error) {
        result.lastError = conn.last_error;
      }
      return result;
    } catch (err) {
      throw mapNangoError(err);
    }
  }

  // -------- Inventory --------------------------------------------

  async getInventory(input: GetInventoryInput): Promise<readonly InventoryRecord[]> {
    const conn = await this.requireConnection(input.merchantId, input.marketplace);
    const provider = toProviderKey(input.marketplace);
    const model = SYNC_NAMES[input.marketplace][0];
    if (!model) return [];
    try {
      let cursor: string | undefined;
      do {
        const res = await this.client.listRecords({
          providerConfigKey: provider,
          connectionId: conn.connectionId,
          model,
          limit: 100,
          ...(cursor ? { cursor } : {})
        });
        const match = res.records.find(
          (r) => String((r as Record<string, unknown>)['id'] ?? '') === input.externalProductId ||
                 String((r as Record<string, unknown>)['externalId'] ?? '') === input.externalProductId
        );
        if (match) {
          const variants = ((match as Record<string, unknown>)['variants'] ?? []) as Array<{ id: string | number; inventoryQuantity?: number }>;
          return variants.map((v) => ({
            locationId: String(v.id),
            available: v.inventoryQuantity ?? 0
          }));
        }
        cursor = res.next_cursor;
      } while (cursor);
      return [];
    } catch (err) {
      throw mapNangoError(err);
    }
  }

  // -------- Webhook ----------------------------------------------

  async verifyAndParseWebhook(input: VerifyAndParseInput): Promise<VerifyAndParseResult> {
    const opts = {
      secret: this.deps.webhookSecret,
      ...(this.deps.webhookSecretNext ? { secretNext: this.deps.webhookSecretNext } : {}),
      ...(this.deps.nowMs ? { nowMs: this.deps.nowMs } : {})
    };
    return verifyAndParseWebhook(input.rawBody, input.headers, opts);
  }

  // -------- Internal ---------------------------------------------

  private async requireConnection(
    merchantId: MerchantId,
    marketplace: Marketplace
  ): Promise<{ tenantId: TenantId; connectionId: ConnectionId }> {
    const conn = await this.deps.lookup.byMerchantMarketplace({ merchantId, marketplace });
    if (!conn) {
      throw new GatewayError(
        "connection_not_found",
        `No active connection for merchant=${merchantId} marketplace=${marketplace}`
      );
    }
    return conn;
  }
}

// Helper for routing webhook events back to a Marketplace value.
export { fromProviderKey };
