import { createDb, schema } from "@aonex/db";
import { eq } from "drizzle-orm";

const db = createDb(process.env.DATABASE_URL!);

const MERCHANT_ID = "cf6fbeb0-427f-4d60-b74b-da98e96abab8";
const NANGO_CONNECTION_ID = "3c35be20-cfa6-4856-8c86-f1cf853ba466";

const merchant = (await db.client.select()
  .from(schema.merchants)
  .where(eq(schema.merchants.id, MERCHANT_ID))
  .limit(1))[0];

if (!merchant) throw new Error(`Merchant ${MERCHANT_ID} not found`);
console.log("Merchant:", merchant.id, "tenant:", merchant.tenantId);

await db.client
  .insert(schema.marketplaceConnections)
  .values({
    tenantId: merchant.tenantId,
    merchantId: merchant.id,
    marketplace: "ebay",
    provider: "nango",
    providerConnectionId: NANGO_CONNECTION_ID,
    status: "active",
    connectedAt: new Date()
  })
  .onConflictDoUpdate({
    target: [schema.marketplaceConnections.merchantId, schema.marketplaceConnections.marketplace],
    set: {
      providerConnectionId: NANGO_CONNECTION_ID,
      status: "active",
      updatedAt: new Date()
    }
  });

console.log("Connection registered: ebay →", NANGO_CONNECTION_ID);
await db.close();
