
import { createDb, schema } from "@aonex/db";
import { parseEnv, MerchantId } from "@aonex/types";
import { ConnectorGateway, ShopifyAdapter, buildGateway, decryptToken } from "@aonex/connector-gateway";
import { eq, and } from "drizzle-orm";

async function debugFetchVerbose() {
  const env = parseEnv();
  const db = createDb(env.DATABASE_URL);
  
  const merchant = await db.client.query.merchants.findFirst({
    where: (m, { eq }) => eq(m.email, "dev@example.com")
  });
  
  if (!merchant) {
    console.error("Merchant not found.");
    process.exit(1);
  }

  const conn = await db.client.query.marketplaceConnections.findFirst({
    where: (c, { and, eq }) => and(eq(c.merchantId, merchant.id), eq(c.marketplace, "shopify"))
  });

  if (!conn || !conn.encryptedAccessToken || !conn.shopDomain) {
    console.error("Connection not found or missing token/domain in DB.");
    process.exit(1);
  }

  const accessToken = decryptToken(conn.encryptedAccessToken, env.TOKEN_ENCRYPTION_KEY);
  const shopDomain = conn.shopDomain;

  console.log(`Directly calling Shopify: https://${shopDomain}/admin/api/2025-01/products.json`);
  console.log(`Using Token: ${accessToken.substring(0, 10)}...`);

  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/2025-01/products.json?limit=1`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );

    console.log(`Status: ${res.status} ${res.statusText}`);
    const body = await res.text();
    console.log("Response Body:", body);

    if (res.ok) {
        console.log("✅ Shopify API accepted the request!");
    } else {
        console.log("❌ Shopify API rejected the request.");
    }
  } catch (err: any) {
    console.error("❌ Network Error:", err.message);
  } finally {
    await db.close();
  }
}

debugFetchVerbose();
