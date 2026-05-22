// Test eBay sandbox via Nango proxy directly (no syncs needed)
const NANGO_HOST = process.env.NANGO_HOST!;
const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY!;
const CONNECTION_ID = "3c35be20-cfa6-4856-8c86-f1cf853ba466";
const EBAY_BASE = process.env.EBAY_API_BASE_URL ?? "https://api.sandbox.ebay.com";

async function proxyGet(path: string) {
  const res = await fetch(`${NANGO_HOST}/proxy${path}`, {
    headers: {
      "Authorization": `Bearer ${NANGO_SECRET_KEY}`,
      "Connection-Id": CONNECTION_ID,
      "Provider-Config-Key": "ebay-sandbox",
      "Baseurl-Override": EBAY_BASE
    }
  });
  const body = await res.text();
  return { status: res.status, body: JSON.parse(body) };
}

console.log("=== eBay Sandbox — Inventory Items ===");
const inv = await proxyGet("/sell/inventory/v1/inventory_item?limit=10");
console.log("Status:", inv.status);
console.log(JSON.stringify(inv.body, null, 2));

console.log("\n=== eBay Sandbox — Orders ===");
const orders = await proxyGet("/sell/fulfillment/v1/order?limit=10");
console.log("Status:", orders.status);
console.log(JSON.stringify(orders.body, null, 2));

console.log("\n=== eBay Sandbox — Offers ===");
const offers = await proxyGet("/sell/inventory/v1/offer?limit=10");
console.log("Status:", offers.status);
console.log(JSON.stringify(offers.body, null, 2));
