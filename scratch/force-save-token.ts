
import { createDb, schema } from "@aonex/db";
import { parseEnv } from "@aonex/types";
import { encryptToken } from "@aonex/connector-gateway";
import { eq } from "drizzle-orm";

async function autoSyncLatestToken() {
  const env = parseEnv();
  const db = createDb(env.DATABASE_URL);
  
  console.log("🔍 Fetching latest Shopify connections from Nango...");
  
  try {
    const response = await fetch("https://api.nango.dev/connection?provider_config_key=shopify", {
        headers: { "Authorization": `Bearer ${env.NANGO_SECRET_KEY}` }
    });
    const data = await response.json();
    
    if (!data.connections || data.connections.length === 0) {
        console.error("❌ No Shopify connections found in Nango. Please connect via browser first.");
        process.exit(1);
    }

    // Sort by created date descending to get the latest
    const latest = data.connections.sort((a: any, b: any) => 
        new Date(b.created).getTime() - new Date(a.created).getTime()
    )[0];

    const NANGO_ID = latest.connection_id;
    console.log(`✅ Found latest connection: ${NANGO_ID} (Created: ${latest.created})`);

    // Fetch full details (including token)
    const detailsResponse = await fetch(`https://api.nango.dev/connection/${NANGO_ID}?provider_config_key=shopify`, {
        headers: { "Authorization": `Bearer ${env.NANGO_SECRET_KEY}` }
    });
    const details = await detailsResponse.json();
    
    const accessToken = details.credentials.access_token;
    const shopDomain = details.connection_config?.subdomain ? `${details.connection_config.subdomain}.myshopify.com` : "unknown.myshopify.com";

    console.log(`🚀 Syncing token for ${shopDomain}...`);

    const merchant = await db.client.query.merchants.findFirst({
        where: (m, { eq }) => eq(m.email, "dev@example.com")
    });

    if (!merchant) throw new Error("Merchant dev@example.com not found.");

    const encryptedAccessToken = encryptToken(accessToken, env.TOKEN_ENCRYPTION_KEY);

    // Upsert
    const existing = await db.client.query.marketplaceConnections.findFirst({
        where: (c, { and, eq }) => and(eq(c.merchantId, merchant.id), eq(c.marketplace, "shopify"))
    });

    if (existing) {
        await db.client.update(schema.marketplaceConnections)
            .set({ 
                providerConnectionId: NANGO_ID,
                encryptedAccessToken,
                shopDomain,
                status: 'active',
                connectedAt: new Date()
            })
            .where(eq(schema.marketplaceConnections.id, existing.id));
    } else {
        await db.client.insert(schema.marketplaceConnections).values({
            tenantId: merchant.tenantId,
            merchantId: merchant.id,
            marketplace: "shopify",
            provider: "nango",
            providerConnectionId: NANGO_ID,
            encryptedAccessToken,
            shopDomain,
            status: "active",
            connectedAt: new Date()
        });
    }

    console.log("✨ All set! Token saved and connection is active.");
  } catch (err: any) {
    console.error("❌ Sync failed:", err.message);
  } finally {
    await db.close();
  }
}

autoSyncLatestToken();
