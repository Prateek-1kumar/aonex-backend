import { type DrizzleClient } from "@aonex/db";
import { type ConnectionId as ConnectionIdT, type Marketplace, type MerchantId, type TenantId } from "@aonex/types";
import type { ConnectionDescriptor, ConnectionLookupPort } from "@aonex/connector-gateway";
export declare class PostgresConnectionRegistry implements ConnectionLookupPort {
    private readonly db;
    constructor(db: DrizzleClient);
    byMerchantMarketplace(input: {
        merchantId: MerchantId;
        marketplace: Marketplace;
    }): Promise<{
        tenantId: TenantId;
        connectionId: ConnectionIdT;
    } | null>;
    listByMerchant(input: {
        merchantId: MerchantId;
    }): Promise<readonly ConnectionDescriptor[]>;
}
//# sourceMappingURL=connection-registry.d.ts.map