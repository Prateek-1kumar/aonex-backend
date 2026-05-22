# eBay Connector Design

**Date:** 2026-05-19  
**Status:** Approved  
**Approach:** Option 1 — Shared `MarketplaceLiveAdapter` interface

---

## Problem

`MarketplaceLiveAdapter`, `ConnectionContext`, and `ProviderProduct` live inside
`adapters/shopify/adapter.ts`. `gateway.ts` imports them from there, coupling the
gateway to a provider-specific file. Adding eBay (or any marketplace) without
fixing this would require the gateway to import from every provider file.

---

## Architecture

Two independent adapter layers remain intact:

| Layer | Class | Purpose |
|---|---|---|
| Nango background | `NangoConnectorAdapter` | Session management, record drain, webhook verify — identical for all marketplaces |
| Provider live | `MarketplaceLiveAdapter` | Real-time proxy calls — one impl per marketplace |

The gateway maps `Marketplace → MarketplaceLiveAdapter` via a registry. Adding a
marketplace = one new file + one registry entry. Gateway never changes.

---

## Shared Interface (new file)

**`packages/connector-gateway/src/contract/provider-adapter.ts`**

```ts
export interface ConnectionContext { tenantId, merchantId, marketplace, connectionId }
export interface ProviderProduct { externalId: string; raw: unknown }
export interface ListProductsInput { connection: ConnectionContext; limit?: number; maxPages?: number }
export interface GetInventoryByConnectionInput { connection: ConnectionContext; externalProductId: string }

export interface MarketplaceLiveAdapter {
  createOAuthUrl(input: CreateOAuthUrlInput): Promise<OAuthUrlResult>
  healthCheck(input: { connection: ConnectionContext }): Promise<boolean>
  listProducts(input: ListProductsInput): Promise<ProviderProduct[]>
  getInventory(input: GetInventoryByConnectionInput): Promise<readonly InventoryRecord[]>
}
```

---

## Files Changed

### Refactor (fix gateway issue)

| File | Change |
|---|---|
| `contract/provider-adapter.ts` | **NEW** — move `MarketplaceLiveAdapter` + supporting types here |
| `adapters/shopify/adapter.ts` | import types from contract instead of defining them |
| `gateway.ts` | import `MarketplaceLiveAdapter` from contract instead of shopify |

### eBay additions

| File | Purpose |
|---|---|
| `adapters/ebay/adapter.ts` | `EbayAdapter implements MarketplaceLiveAdapter` + `NangoProxyEbayTransport` |
| `adapters/nango/normalize/ebay.ts` | `normalizeEbayRecord` — strips Nango metadata, extracts `externalId` |
| `adapters/nango/normalize/index.ts` | Register `ebay: normalizeEbayRecord` |
| `adapters/nango/provider-key.ts` | Extend `SYNC_NAMES.ebay` to `["ebay-inventory-items", "ebay-orders", "ebay-offers"]` |
| `apps/nango/ebay/syncs/ebay-inventory-items.ts` | `createSync` — `GET /sell/inventory/v1/inventory_item`, cursor pagination, checkpoint on `lastModifiedDate` |
| `apps/nango/ebay/syncs/ebay-orders.ts` | `createSync` — `GET /sell/fulfillment/v1/order`, checkpoint on `creationDate` |
| `apps/nango/ebay/syncs/ebay-offers.ts` | `createSync` — `GET /sell/inventory/v1/offer`, cursor pagination |
| `apps/nango/index.ts` | Add 3 eBay sync side-effect imports |
| `apps/api/src/routes/ebay.ts` | Hono routes: `/connect`, `/callback`, `/inventory`, `/orders`, `/offers` |

---

## eBay REST Endpoints

| Sync | Endpoint | Pagination |
|---|---|---|
| `ebay-inventory-items` | `GET /sell/inventory/v1/inventory_item?limit=100&offset=N` | offset/limit |
| `ebay-orders` | `GET /sell/fulfillment/v1/order?limit=50&filter=creationdate:[{after}]` | cursor (`next` in response) |
| `ebay-offers` | `GET /sell/inventory/v1/offer?limit=100&offset=N` | offset/limit |

---

## API Routes (`apps/api/src/routes/ebay.ts`)

```
POST /api/marketplaces/ebay/connect    → createConnectSession + EbayAdapter.createOAuthUrl
GET  /api/marketplaces/ebay/callback   → confirm connection, enqueue initial sync
GET  /api/marketplaces/ebay/inventory  → gateway.listRecords (Nango drain, model=ebay-inventory-items)
GET  /api/marketplaces/ebay/orders     → gateway.listRecords (Nango drain, model=ebay-orders)
GET  /api/marketplaces/ebay/offers     → gateway.listRecords (Nango drain, model=ebay-offers)
```

---

## OAuth Scopes

```
https://api.ebay.com/oauth/api_scope
https://api.ebay.com/oauth/api_scope/sell.inventory
https://api.ebay.com/oauth/api_scope/sell.fulfillment
https://api.ebay.com/oauth/api_scope/sell.marketing
```

---

## Nango Provider Config (`ebay` integration in Nango dashboard)

```yaml
provider: ebay
client_id: DhruvPat-aonex-SBX-0183ec2e3-c8102afa
scopes:
  - https://api.ebay.com/oauth/api_scope
  - https://api.ebay.com/oauth/api_scope/sell.inventory
  - https://api.ebay.com/oauth/api_scope/sell.fulfillment
  - https://api.ebay.com/oauth/api_scope/sell.marketing
sandbox: true   # flip to false for production
```

---

## Environment Variables

```env
NANGO_SECRET_KEY=...
NANGO_HOST=https://api.nango.dev
NANGO_WEBHOOK_SECRET=...
EBAY_API_BASE_URL=https://api.sandbox.ebay.com   # or https://api.ebay.com
```
