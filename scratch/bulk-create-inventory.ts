// Bulk create inventory items in eBay sandbox via Nango proxy.
// Usage: NANGO_HOST=... NANGO_SECRET_KEY=... npx tsx scratch/bulk-create-inventory.ts
const NANGO_HOST = process.env.NANGO_HOST!;
const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY!;
const CONNECTION_ID = "3c35be20-cfa6-4856-8c86-f1cf853ba466";
const EBAY_BASE = process.env.EBAY_API_BASE_URL ?? "https://api.sandbox.ebay.com";

const payload = {
  requests: [
    {
      sku: "TEST-SKU-001",
      locale: "en_US",
      condition: "NEW",
      product: {
        title: "Test Product One — Aonami Sandbox",
        description: "A test inventory item created via the Inventory API.",
        aspects: {
          Brand: ["TestBrand"],
          Type: ["Widget"]
        },
        imageUrls: [
          "https://ir.ebaystatic.com/pictures/aw/pics/stockimage1.jpg"
        ]
      },
      availability: {
        shipToLocationAvailability: {
          quantity: 10
        }
      }
    },
    {
      sku: "TEST-SKU-002",
      locale: "en_US",
      condition: "USED_EXCELLENT",
      conditionDescription: "Lightly used, no visible wear.",
      product: {
        title: "Test Product Two — Aonami Sandbox",
        description: "A second test inventory item created via the Inventory API.",
        aspects: {
          Brand: ["TestBrand"],
          Color: ["Blue"]
        },
        imageUrls: [
          "https://ir.ebaystatic.com/pictures/aw/pics/stockimage1.jpg"
        ]
      },
      availability: {
        shipToLocationAvailability: {
          quantity: 5
        }
      }
    }
  ]
};

const res = await fetch(
  `${NANGO_HOST}/proxy/sell/inventory/v1/bulk_create_or_replace_inventory_item`,
  {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NANGO_SECRET_KEY}`,
      "Connection-Id": CONNECTION_ID,
      "Provider-Config-Key": "ebay-sandbox",
      "Baseurl-Override": EBAY_BASE,
      "Content-Type": "application/json",
      "Content-Language": "en-US"
    },
    body: JSON.stringify(payload)
  }
);

const body = await res.text();
console.log("HTTP Status:", res.status);
try {
  console.log(JSON.stringify(JSON.parse(body), null, 2));
} catch {
  console.log(body);
}
