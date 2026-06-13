// Admin port: connection lifecycle (connect session, inspect, list, revoke,
// token-health) for the connector gateway.

import type { ConnectionDescriptor, ConnectSessionToken } from "./connection.js";
import type {
  ConnectionId,
  Marketplace,
  MerchantId,
  TenantId
} from "@aonex/types";
import type { TokenHealthResult } from "./records.js";

export interface CreateConnectSessionInput {
  tenantId: TenantId;
  merchantId: MerchantId;
  marketplaces: readonly Marketplace[];
  /** Optional URL to redirect back to after OAuth completes. */
  redirectUrl?: string;
}

export interface OAuthUrlResult {
  /** URL the frontend should redirect the merchant to (or open as popup). */
  url: string;
  expiresAt: Date;
}

export interface CreateOAuthUrlInput {
  merchantId: MerchantId;
  /** Pre-created connect session token (created by caller before invoking this). */
  sessionToken: string;
}

export interface IConnectorAdmin {
  /**
   * Mint an opaque session token for the Nango Connect UI. Provider OAuth
   * happens in the UI and tokens are stored in Nango; we never see the raw
   * provider tokens.
   */
  createConnectSession(input: CreateConnectSessionInput): Promise<ConnectSessionToken>;

  /** Inspect a stored connection — returns null if not found. */
  getConnection(input: {
    merchantId: MerchantId;
    marketplace: Marketplace;
  }): Promise<ConnectionDescriptor | null>;

  /** List connections for a merchant. */
  listConnections(input: { merchantId: MerchantId }): Promise<readonly ConnectionDescriptor[]>;

  /** Revoke an active connection. Idempotent. */
  revoke(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<void>;

  /**
   * Provider-side token health check — used by the connection-sweeper
   * BullMQ cron to flip refresh_failing → revoked after 24h.
   */
  refreshTokenHealth(input: {
    connectionId: ConnectionId;
    marketplace: Marketplace;
  }): Promise<TokenHealthResult>;

}
