
import { createDb, schema } from "@aonex/db";
import { ConnectorGateway, ShopifyAdapter, buildGateway } from "@aonex/connector-gateway";
import { parseEnv, MerchantId } from "@aonex/types";
import { eq, and } from "drizzle-orm";

async function syncToken() {
  const env = parseEnv();
  const db = createDb(env.DATABASE_URL);
  
  // 1. Get the merchant (dev@example.com)
  const merchant = await db.client.query.merchants.findFirst({
    where: (m, { eq }) => eq(m.email, "dev@example.com")
  });
  
  if (!merchant) {
    console.error("Merchant not found. Run seed first.");
    process.exit(1);
  }

  // Found via API: 19ac8d3b-cd1b-4780-8400-27e286a1528d
  const NANGO_CONNECTION_ID = "19ac8d3b-cd1b-4780-8400-27e286a1528d"; 

  // 2. Upsert the connection entry
  console.log(`Checking/Creating connection entry for merchant: ${merchant.id} with Nango ID: ${NANGO_CONNECTION_ID}`);
  
  const existing = await db.client.query.marketplaceConnections.findFirst({
    where: (c, { and, eq }) => and(eq(c.merchantId, merchant.id), eq(c.marketplace, "shopify"))
  });

  if (existing) {
    await db.client.update(schema.marketplaceConnections)
      .set({ providerConnectionId: NANGO_CONNECTION_ID })
      .where(eq(schema.marketplaceConnections.id, existing.id));
  } else {
    await db.client.insert(schema.marketplaceConnections).values({
      tenantId: merchant.tenantId,
      merchantId: merchant.id,
      marketplace: "shopify",
      provider: "nango",
      providerConnectionId: NANGO_CONNECTION_ID,
      status: "pending"
    });
  }

  // 3. Initialize Gateway
  const gateway = new ConnectorGateway({
    db: db.client,
    tokenKey: env.TOKEN_ENCRYPTION_KEY,
    nango: buildGateway({ env, lookup: {} as any }) as any,
    shopify: new ShopifyAdapter({ nangoConnectBaseUrl: env.NANGO_CONNECT_BASE_URL })
  });

  // 4. Fetch and store
  try {
    console.log(`Fetching token for Nango connection: ${NANGO_CONNECTION_ID}...`);
    await gateway.fetchAndStoreToken({
      connectionId: NANGO_CONNECTION_ID,
      merchantId: merchant.id as any,
      marketplace: "shopify"
    });
    
    // Mark as active
    await db.client.update(schema.marketplaceConnections)
      .set({ status: 'active', connectedAt: new Date() })
      .where(and(
        eq(schema.marketplaceConnections.merchantId, merchant.id),
        eq(schema.marketplaceConnections.marketplace, "shopify")
      ));
      
    console.log("✅ Token successfully stored and connection marked as 'active'!");
  } catch (err) {
    console.error("❌ Failed to fetch token from Nango:", err);
  } finally {
    await db.close();
  }
}

syncToken();
