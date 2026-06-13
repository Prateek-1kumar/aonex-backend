// Connection-level domain types (status, descriptor, connect-session token).
// IDs are branded in @aonex/types so a MerchantId cannot stand in for a ConnectionId.

import type { ConnectionId, Marketplace, MerchantId, TenantId } from "@aonex/types";

export type ConnectionStatus =
  | "pending"
  | "pending_failed"
  | "active"
  | "refresh_failing"
  | "revoked"
  | "deleted";

export interface ConnectionDescriptor {
  tenantId: TenantId;
  merchantId: MerchantId;
  marketplace: Marketplace;
  connectionId: ConnectionId;
  status: ConnectionStatus;
  scopes: readonly string[];
  connectedAt?: Date;
  lastTokenRefreshAt?: Date;
}

/** Result of `gateway.createConnectSession(...)` — used by the UI. */
export interface ConnectSessionToken {
  /** Opaque token to pass to Nango Connect UI. */
  token: string;
  expiresAt: Date;
}
