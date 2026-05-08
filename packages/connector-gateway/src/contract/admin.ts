// Admin port — connection lifecycle management.
// Maps to HLD §17 `refreshTokenHealth`, `revoke`.

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

export interface IConnectorAdmin {
  /**
   * Mint an opaque session token for the Nango Connect UI.
   * Frontend opens the UI with this token; provider OAuth happens
   * in a popup; provider tokens are stored in Nango (HLD §22 — we
   * never see the raw provider tokens).
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
