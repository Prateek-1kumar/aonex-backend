// PostgresConnectionRegistry — the Postgres impl of
// ConnectionLookupPort. Routes/processors take the port, never
// the registry directly.
import { and, eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import { ConnectionId } from "@aonex/types";
export class PostgresConnectionRegistry {
    db;
    constructor(db) {
        this.db = db;
    }
    async byMerchantMarketplace(input) {
        const rows = await this.db
            .select({
            tenantId: schema.marketplaceConnections.tenantId,
            providerConnectionId: schema.marketplaceConnections.providerConnectionId,
            status: schema.marketplaceConnections.status
        })
            .from(schema.marketplaceConnections)
            .where(and(eq(schema.marketplaceConnections.merchantId, input.merchantId), eq(schema.marketplaceConnections.marketplace, input.marketplace)))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        if (row.status === "revoked" || row.status === "deleted")
            return null;
        return {
            tenantId: row.tenantId,
            connectionId: ConnectionId.unsafeFrom(row.providerConnectionId)
        };
    }
    async listByMerchant(input) {
        const rows = await this.db
            .select()
            .from(schema.marketplaceConnections)
            .where(eq(schema.marketplaceConnections.merchantId, input.merchantId));
        return rows.map((r) => {
            const desc = {
                tenantId: r.tenantId,
                merchantId: r.merchantId,
                marketplace: r.marketplace,
                connectionId: ConnectionId.unsafeFrom(r.providerConnectionId),
                status: r.status,
                scopes: r.scopes
            };
            if (r.connectedAt)
                desc.connectedAt = r.connectedAt;
            if (r.lastTokenRefreshAt)
                desc.lastTokenRefreshAt = r.lastTokenRefreshAt;
            return desc;
        });
    }
}
//# sourceMappingURL=connection-registry.js.map