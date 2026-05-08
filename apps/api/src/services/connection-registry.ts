// PostgresConnectionRegistry — the Postgres impl of
// ConnectionLookupPort. Routes/processors take the port, never
// the registry directly.

import { and, eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import {
  ConnectionId,
  type ConnectionId as ConnectionIdT,
  type Marketplace,
  type MerchantId,
  type TenantId
} from "@aonex/types";
import type {
  ConnectionDescriptor,
  ConnectionLookupPort
} from "@aonex/connector-gateway";

export class PostgresConnectionRegistry implements ConnectionLookupPort {
  constructor(private readonly db: DrizzleClient) {}

  async byMerchantMarketplace(input: {
    merchantId: MerchantId;
    marketplace: Marketplace;
  }): Promise<{ tenantId: TenantId; connectionId: ConnectionIdT } | null> {
    const rows = await this.db
      .select({
        tenantId: schema.marketplaceConnections.tenantId,
        providerConnectionId: schema.marketplaceConnections.providerConnectionId,
        status: schema.marketplaceConnections.status
      })
      .from(schema.marketplaceConnections)
      .where(
        and(
          eq(schema.marketplaceConnections.merchantId, input.merchantId),
          eq(schema.marketplaceConnections.marketplace, input.marketplace)
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.status === "revoked" || row.status === "deleted") return null;
    return {
      tenantId: row.tenantId as TenantId,
      connectionId: ConnectionId.unsafeFrom(row.providerConnectionId)
    };
  }

  async listByMerchant(input: { merchantId: MerchantId }): Promise<readonly ConnectionDescriptor[]> {
    const rows = await this.db
      .select()
      .from(schema.marketplaceConnections)
      .where(eq(schema.marketplaceConnections.merchantId, input.merchantId));
    return rows.map((r) => {
      const desc: ConnectionDescriptor = {
        tenantId: r.tenantId as TenantId,
        merchantId: r.merchantId as MerchantId,
        marketplace: r.marketplace,
        connectionId: ConnectionId.unsafeFrom(r.providerConnectionId),
        status: r.status,
        scopes: r.scopes
      };
      if (r.connectedAt) desc.connectedAt = r.connectedAt;
      if (r.lastTokenRefreshAt) desc.lastTokenRefreshAt = r.lastTokenRefreshAt;
      return desc;
    });
  }
}
