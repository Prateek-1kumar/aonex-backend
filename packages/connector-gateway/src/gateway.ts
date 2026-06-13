// ConnectorGateway: marketplace routing facade. Resolves a connection, builds a
// ConnectionContext, and dispatches to the right live adapter (or delegates
// session/drain/webhook work to Nango) so callers never touch adapters or tokens.

import { GatewayError, type MerchantId, type Marketplace, type TenantId, type ConnectionId } from '@aonex/types';
import type {
  InventoryRecord,
  OAuthUrlResult,
  ConnectSessionToken,
  CreateConnectSessionInput,
  ConnectionDescriptor,
  VerifyAndParseInput,
  VerifyAndParseResult,
  DrainOptions,
  CanonicalProductRecord,
  SyncStatus,
  TokenHealthResult,
  ConnectionContext,
  MarketplaceLiveAdapter,
  ProviderProduct,
  ListRecordsInput,
  ListRecordsResult
} from './contract/index.js';

export interface ConnectionLifecycleAdapter {
  createConnectSession(input: CreateConnectSessionInput): Promise<ConnectSessionToken>;
  getConnection(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<ConnectionDescriptor | null>;
  listConnections(input: { merchantId: MerchantId }): Promise<readonly ConnectionDescriptor[]>;
  revoke(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<void>;
  refreshTokenHealth(input: { connectionId: ConnectionId; marketplace: Marketplace }): Promise<TokenHealthResult>;
  verifyAndParseWebhook(input: VerifyAndParseInput): Promise<VerifyAndParseResult>;
  drainProducts(
    input: { merchantId: MerchantId; marketplace: Marketplace },
    opts?: DrainOptions
  ): AsyncIterable<CanonicalProductRecord[]>;
  getSyncStatus(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<SyncStatus>;
  listRecords(input: ListRecordsInput): Promise<ListRecordsResult>;
}

export interface ConnectionLookupAdapter {
  byMerchantMarketplace(input: {
    merchantId: MerchantId;
    marketplace: Marketplace;
  }): Promise<{ tenantId: TenantId; connectionId: ConnectionId } | null>;
}

export interface ConnectorGatewayDeps {
  lookup: ConnectionLookupAdapter;
  /** Nango-backed adapter for session creation, drain, webhook verification */
  nango: ConnectionLifecycleAdapter;
  marketplaceAdapters: Partial<Record<Marketplace, MarketplaceLiveAdapter>>;
}

export class ConnectorGateway {
  constructor(private readonly deps: ConnectorGatewayDeps) {}

  private getAdapter(marketplace: Marketplace): MarketplaceLiveAdapter {
    const adapter = this.deps.marketplaceAdapters[marketplace];
    if (!adapter) {
      throw new GatewayError('validation_failed', 'UNSUPPORTED_MARKETPLACE');
    }
    return adapter;
  }

  async loadConnection(merchantId: MerchantId, marketplace: Marketplace): Promise<ConnectionContext> {
    const connection = await this.deps.lookup.byMerchantMarketplace({ merchantId, marketplace });
    if (!connection) {
      throw new GatewayError('connection_not_found', `No connection for merchant=${merchantId} marketplace=${marketplace}`);
    }

    return {
      tenantId: connection.tenantId,
      merchantId,
      marketplace,
      connectionId: connection.connectionId
    };
  }

  async createOAuthUrl(merchantId: MerchantId, tenantId: TenantId, marketplace: Marketplace): Promise<OAuthUrlResult> {
    const session = await this.deps.nango.createConnectSession({
      tenantId,
      merchantId,
      marketplaces: [marketplace]
    });
    return this.getAdapter(marketplace).createOAuthUrl({
      merchantId,
      sessionToken: session.token
    });
  }

  async healthCheck(merchantId: MerchantId, marketplace: Marketplace): Promise<boolean> {
    const conn = await this.loadConnection(merchantId, marketplace);
    return this.getAdapter(marketplace).healthCheck({ connection: conn });
  }

  async listProducts(merchantId: MerchantId, marketplace: Marketplace): Promise<ProviderProduct[]> {
    const conn = await this.loadConnection(merchantId, marketplace);
    return this.getAdapter(marketplace).listProducts({ connection: conn });
  }

  async getInventory(merchantId: MerchantId, marketplace: Marketplace, externalProductId: string): Promise<readonly InventoryRecord[]> {
    const conn = await this.loadConnection(merchantId, marketplace);
    return this.getAdapter(marketplace).getInventory({ connection: conn, externalProductId });
  }

  async createConnectSession(input: CreateConnectSessionInput): Promise<ConnectSessionToken> {
    return this.deps.nango.createConnectSession(input);
  }

  async getConnection(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<ConnectionDescriptor | null> {
    return this.deps.nango.getConnection(input);
  }

  async listConnections(input: { merchantId: MerchantId }): Promise<readonly ConnectionDescriptor[]> {
    return this.deps.nango.listConnections(input);
  }

  async revoke(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<void> {
    return this.deps.nango.revoke(input);
  }

  async refreshTokenHealth(input: { connectionId: ConnectionId; marketplace: Marketplace }): Promise<TokenHealthResult> {
    return this.deps.nango.refreshTokenHealth(input);
  }

  async verifyAndParseWebhook(input: VerifyAndParseInput): Promise<VerifyAndParseResult> {
    return this.deps.nango.verifyAndParseWebhook(input);
  }

  async *drainProducts(
    input: { merchantId: MerchantId; marketplace: Marketplace },
    opts?: DrainOptions
  ): AsyncIterable<CanonicalProductRecord[]> {
    yield* this.deps.nango.drainProducts(input, opts);
  }

  async getSyncStatus(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<SyncStatus> {
    return this.deps.nango.getSyncStatus(input);
  }

  async listRecords(input: ListRecordsInput): Promise<ListRecordsResult> {
    return this.deps.nango.listRecords(input);
  }
}
