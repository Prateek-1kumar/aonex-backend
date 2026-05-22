# eBay Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full eBay marketplace connector (OAuth via Nango, 3 background syncs, live proxy adapter, 5 API routes) that is structurally identical to the existing Shopify connector, using a single shared `MarketplaceLiveAdapter` interface.

**Architecture:** Fix the gateway coupling by moving `MarketplaceLiveAdapter` + supporting types from `adapters/shopify/adapter.ts` into `contract/provider-adapter.ts`. `EbayAdapter` then implements the same shared interface. `ConnectorGateway` resolves the right adapter from a `Marketplace → MarketplaceLiveAdapter` registry. Three Nango background syncs feed Nango's records cache; five Hono routes expose connect, callback, inventory, orders, and offers.

**Tech Stack:** TypeScript, Bun (test runner: `bun test`), Hono, Nango SDK (`createSync`, `nango.get`), Zod, `@aonex/connector-gateway`, `@aonex/types`.

---

## File Map

### Create
| Path | Responsibility |
|---|---|
| `packages/connector-gateway/src/contract/provider-adapter.ts` | `MarketplaceLiveAdapter`, `ConnectionContext`, `ProviderProduct`, `ListProductsInput`, `GetInventoryByConnectionInput` |
| `packages/connector-gateway/src/adapters/ebay/adapter.ts` | `EbayAdapter implements MarketplaceLiveAdapter`, `NangoProxyEbayTransport` |
| `packages/connector-gateway/src/adapters/ebay/adapter.test.ts` | Unit tests for `EbayAdapter` |
| `packages/connector-gateway/src/adapters/nango/normalize/ebay.ts` | `normalizeEbayRecord` — strips Nango metadata, extracts stable `externalId` |
| `apps/nango/ebay/syncs/ebay-inventory-items.ts` | Nango sync — `GET /sell/inventory/v1/inventory_item`, offset pagination |
| `apps/nango/ebay/syncs/ebay-orders.ts` | Nango sync — `GET /sell/fulfillment/v1/order`, checkpoint on `creationDate` |
| `apps/nango/ebay/syncs/ebay-offers.ts` | Nango sync — `GET /sell/inventory/v1/offer`, offset pagination |
| `apps/api/src/routes/ebay.ts` | Hono routes: `/connect`, `/callback`, `/inventory`, `/orders`, `/offers` |
| `apps/api/src/routes/ebay.test.ts` | Unit tests for eBay routes |

### Modify
| Path | Change |
|---|---|
| `packages/connector-gateway/src/contract/index.ts` | `export * from "./provider-adapter.js"` |
| `packages/connector-gateway/src/contract/records.ts` | Add `model?: string` to `ListRecordsInput` |
| `packages/connector-gateway/src/adapters/shopify/adapter.ts` | Remove shared type definitions; import from `contract/provider-adapter.js` |
| `packages/connector-gateway/src/adapters/nango/adapter.ts` | Use `input.model ?? SYNC_NAMES[marketplace][0]` in `listRecords` |
| `packages/connector-gateway/src/adapters/nango/normalize/index.ts` | Register `ebay: normalizeEbayRecord` |
| `packages/connector-gateway/src/adapters/nango/provider-key.ts` | `SYNC_NAMES.ebay = ["ebay-inventory-items", "ebay-orders", "ebay-offers"]` |
| `packages/connector-gateway/src/gateway.ts` | Fix import (contract not shopify); add `listRecords` delegation |
| `packages/connector-gateway/src/index.ts` | Export `EbayAdapter`, `NangoProxyEbayTransport`; re-point shared type exports to contract |
| `apps/nango/index.ts` | Add 3 eBay sync side-effect imports |
| `apps/api/src/composition-root.ts` | Instantiate `EbayAdapter`, register in `marketplaceAdapters`, mount `/marketplaces/ebay` route |

---

## Task 1: Create `contract/provider-adapter.ts` — shared interface

**Files:**
- Create: `packages/connector-gateway/src/contract/provider-adapter.ts`
- Modify: `packages/connector-gateway/src/contract/index.ts`

- [ ] **Step 1: Create the shared types file**

```ts
// packages/connector-gateway/src/contract/provider-adapter.ts
import type { Marketplace, MerchantId } from "@aonex/types";
import type { OAuthUrlResult, CreateOAuthUrlInput } from "./admin.js";
import type { InventoryRecord } from "./inventory.js";

export interface ConnectionContext {
  tenantId: string;
  merchantId: MerchantId;
  marketplace: Marketplace;
  connectionId: string;
}

export interface ProviderProduct {
  externalId: string;
  raw: unknown;
}

export interface ListProductsInput {
  connection: ConnectionContext;
  limit?: number;
  maxPages?: number;
}

export interface GetInventoryByConnectionInput {
  connection: ConnectionContext;
  externalProductId: string;
}

export interface MarketplaceLiveAdapter {
  createOAuthUrl(input: CreateOAuthUrlInput): Promise<OAuthUrlResult>;
  healthCheck(input: { connection: ConnectionContext }): Promise<boolean>;
  listProducts(input: ListProductsInput): Promise<ProviderProduct[]>;
  getInventory(input: GetInventoryByConnectionInput): Promise<readonly InventoryRecord[]>;
}
```

- [ ] **Step 2: Re-export from `contract/index.ts`**

Open `packages/connector-gateway/src/contract/index.ts`. Add this line at the bottom:

```ts
export * from "./provider-adapter.js";
```

---

## Task 2: Fix Shopify adapter — import from contract instead of defining

**Files:**
- Modify: `packages/connector-gateway/src/adapters/shopify/adapter.ts`

- [ ] **Step 1: Replace the 5 type definitions with imports**

In `adapters/shopify/adapter.ts`, find these four interface definitions and the one export interface:

```ts
export interface ConnectionContext { ... }
export interface ProviderProduct { ... }
export interface ListProductsInput { ... }
export interface GetInventoryByConnectionInput { ... }
export interface MarketplaceLiveAdapter { ... }
```

Replace them with a single import at the top of the file (after the existing imports):

```ts
import type {
  ConnectionContext,
  ProviderProduct,
  ListProductsInput,
  GetInventoryByConnectionInput,
  MarketplaceLiveAdapter
} from '../../contract/provider-adapter.js';
```

Remove the 5 `export interface` blocks. Everything else in the file stays unchanged.

- [ ] **Step 2: Run typecheck to verify the refactor compiles**

```bash
cd packages/connector-gateway && bun run typecheck
```

Expected: no errors. If you see "duplicate identifier" errors, you missed one of the 5 definitions. If you see "cannot find module", double-check the relative path `../../contract/provider-adapter.js`.

- [ ] **Step 3: Run the existing adapter test to verify nothing broke**

```bash
cd packages/connector-gateway && bun test src/adapters/shopify/adapter.test.ts
```

Expected: all tests pass (same as before the refactor).

---

## Task 3: Fix `gateway.ts` import + add `listRecords` delegation

**Files:**
- Modify: `packages/connector-gateway/src/gateway.ts`

- [ ] **Step 1: Fix the import**

In `gateway.ts`, find:

```ts
import type { ConnectionContext, MarketplaceLiveAdapter, ProviderProduct } from './adapters/shopify/adapter.js';
```

Replace with:

```ts
import type { ConnectionContext, MarketplaceLiveAdapter, ProviderProduct } from './contract/provider-adapter.js';
```

- [ ] **Step 2: Add `listRecords` to `ConnectionLifecycleAdapter`**

In `gateway.ts`, find the `ConnectionLifecycleAdapter` interface and add `listRecords`:

```ts
export interface ConnectionLifecycleAdapter {
  createConnectSession(input: CreateConnectSessionInput): Promise<ConnectSessionToken>;
  getConnection(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<ConnectionDescriptor | null>;
  listConnections(input: { merchantId: MerchantId }): Promise<readonly ConnectionDescriptor[]>;
  revoke(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<void>;
  refreshTokenHealth(input: { connectionId: ConnectionId; marketplace: Marketplace }): Promise<TokenHealthResult>;
  verifyAndParseWebhook(input: VerifyAndParseInput): Promise<VerifyAndParseResult>;
  drainProducts(
    input: { merchantId: MerchantId; marketplace: Marketplace },
    opts?: DrainOptions
  ): AsyncIterable<CanonicalProductRecord[]>;
  getSyncStatus(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<SyncStatus>;
  listRecords(input: ListRecordsInput): Promise<ListRecordsResult>;
}
```

- [ ] **Step 3: Add `listRecords` method to `ConnectorGateway` class**

Inside the `ConnectorGateway` class, after the `getSyncStatus` method (around line 150), add:

```ts
async listRecords(input: ListRecordsInput): Promise<ListRecordsResult> {
  return this.deps.nango.listRecords(input);
}
```

- [ ] **Step 4: Run typecheck**

```bash
cd packages/connector-gateway && bun run typecheck
```

Expected: no errors.

---

## Task 4: Add `model` field to `ListRecordsInput` + use it in `NangoConnectorAdapter`

**Files:**
- Modify: `packages/connector-gateway/src/contract/records.ts`
- Modify: `packages/connector-gateway/src/adapters/nango/adapter.ts`

The current `listRecords` always picks `SYNC_NAMES[marketplace][0]`. eBay has 3 models. Adding optional `model` lets callers specify which one.

- [ ] **Step 1: Add `model?` to `ListRecordsInput` in `records.ts`**

Find:

```ts
export interface ListRecordsInput {
  merchantId: MerchantId;
  marketplace: Marketplace;
  modifiedAfter?: Date;
  cursor?: string;
  pageSize?: number;
}
```

Replace with:

```ts
export interface ListRecordsInput {
  merchantId: MerchantId;
  marketplace: Marketplace;
  /** Nango sync model name. Defaults to SYNC_NAMES[marketplace][0] if omitted. */
  model?: string;
  modifiedAfter?: Date;
  cursor?: string;
  pageSize?: number;
}
```

- [ ] **Step 2: Use `input.model` in `NangoConnectorAdapter.listRecords`**

In `adapters/nango/adapter.ts`, find inside `listRecords`:

```ts
const model = SYNC_NAMES[input.marketplace][0];
if (!model) {
  throw new GatewayError("validation_failed", `No sync model for ${input.marketplace}`);
}
```

Replace with:

```ts
const model = input.model ?? SYNC_NAMES[input.marketplace][0];
if (!model) {
  throw new GatewayError("validation_failed", `No sync model for ${input.marketplace}`);
}
```

- [ ] **Step 3: Write the failing test**

In `packages/connector-gateway/src/adapters/nango/adapter.test.ts` (or create it next to the adapter), add:

```ts
import { describe, it, expect } from 'bun:test';
import { NangoConnectorAdapter } from './adapter.js';
import type { ConnectionLookupPort } from './adapter.js';

function makeLookup(): ConnectionLookupPort {
  return {
    byMerchantMarketplace: async () => ({
      tenantId: 'tenant-1' as any,
      connectionId: 'conn-1' as any
    }),
    listByMerchant: async () => []
  };
}

describe('NangoConnectorAdapter.listRecords — model override', () => {
  it('passes explicit model to nango client instead of SYNC_NAMES[0]', async () => {
    let capturedModel = '';
    const fakeClient = {
      listRecords: async (args: { model: string }) => {
        capturedModel = args.model;
        return { records: [] };
      }
    } as any;

    const adapter = new NangoConnectorAdapter({
      client: fakeClient,
      lookup: makeLookup(),
      webhookSecret: 'secret'
    });

    await adapter.listRecords({
      merchantId: 'merchant-1' as any,
      marketplace: 'ebay',
      model: 'ebay-orders'
    });

    expect(capturedModel).toBe('ebay-orders');
  });

  it('falls back to SYNC_NAMES[0] when model is omitted', async () => {
    let capturedModel = '';
    const fakeClient = {
      listRecords: async (args: { model: string }) => {
        capturedModel = args.model;
        return { records: [] };
      }
    } as any;

    const adapter = new NangoConnectorAdapter({
      client: fakeClient,
      lookup: makeLookup(),
      webhookSecret: 'secret'
    });

    await adapter.listRecords({
      merchantId: 'merchant-1' as any,
      marketplace: 'shopify'
    });

    expect(capturedModel).toBe('shopify-products');
  });
});
```

- [ ] **Step 4: Run test to see it fail**

```bash
cd packages/connector-gateway && bun test --grep "model override"
```

Expected: FAIL — the first test should fail because the adapter uses `SYNC_NAMES[0]` not `input.model` (before Step 2 above is applied).

- [ ] **Step 5: Confirm tests pass after the fix (Step 2)**

```bash
cd packages/connector-gateway && bun test --grep "model override"
```

Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/connector-gateway/src/contract/provider-adapter.ts \
        packages/connector-gateway/src/contract/index.ts \
        packages/connector-gateway/src/contract/records.ts \
        packages/connector-gateway/src/adapters/shopify/adapter.ts \
        packages/connector-gateway/src/adapters/nango/adapter.ts \
        packages/connector-gateway/src/adapters/nango/adapter.test.ts \
        packages/connector-gateway/src/gateway.ts
git commit -m "refactor(connector-gateway): move MarketplaceLiveAdapter to contract; add model param to listRecords"
```

---

## Task 5: Extend eBay SYNC_NAMES + add eBay normalizer

**Files:**
- Modify: `packages/connector-gateway/src/adapters/nango/provider-key.ts`
- Create: `packages/connector-gateway/src/adapters/nango/normalize/ebay.ts`
- Modify: `packages/connector-gateway/src/adapters/nango/normalize/index.ts`

- [ ] **Step 1: Write the failing normalizer test**

Create `packages/connector-gateway/src/adapters/nango/normalize/ebay.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { normalizeEbayRecord } from './ebay.js';

describe('normalizeEbayRecord', () => {
  it('uses sku as externalId for inventory items', () => {
    const raw = { sku: 'ITEM-123', condition: 'NEW', _nango_metadata: { deleted_at: null } };
    const result = normalizeEbayRecord(raw, { marketplace: 'ebay' });
    expect(result.externalId).toBe('ITEM-123');
    expect(result.marketplace).toBe('ebay');
    expect((result.raw as any)._nango_metadata).toBeUndefined();
  });

  it('uses orderId as externalId for orders', () => {
    const raw = {
      orderId: 'ORD-001',
      creationDate: '2024-01-15T10:00:00.000Z',
      lastModifiedDate: '2024-01-16T10:00:00.000Z'
    };
    const result = normalizeEbayRecord(raw, { marketplace: 'ebay' });
    expect(result.externalId).toBe('ORD-001');
    expect(result.modifiedAt).toEqual(new Date('2024-01-16T10:00:00.000Z'));
  });

  it('uses offerId as externalId for offers', () => {
    const raw = { offerId: 'OFF-999', sku: 'ITEM-123', status: 'PUBLISHED' };
    const result = normalizeEbayRecord(raw, { marketplace: 'ebay' });
    expect(result.externalId).toBe('OFF-999');
  });

  it('throws when no stable id is present', () => {
    expect(() => normalizeEbayRecord({ title: 'broken' }, { marketplace: 'ebay' })).toThrow(
      'eBay record missing stable id'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/connector-gateway && bun test src/adapters/nango/normalize/ebay.test.ts
```

Expected: FAIL — `normalizeEbayRecord` does not exist yet.

- [ ] **Step 3: Create the normalizer**

```ts
// packages/connector-gateway/src/adapters/nango/normalize/ebay.ts
import { removeNangoMetadata } from "@aonex/lib-utils";
import type { CanonicalProductRecord } from "../../../contract/records.js";
import type { Marketplace } from "@aonex/types";

interface EbayRecord {
  sku?: string;
  orderId?: string;
  offerId?: string;
  lastModifiedDate?: string;
  creationDate?: string;
  [k: string]: unknown;
}

export function normalizeEbayRecord(
  raw: Record<string, unknown>,
  ctx: { marketplace: Marketplace }
): CanonicalProductRecord {
  const stripped = removeNangoMetadata(raw) as EbayRecord;
  const externalId = String(stripped.orderId ?? stripped.offerId ?? stripped.sku ?? "");
  if (!externalId) {
    throw new Error("eBay record missing stable id (orderId / offerId / sku)");
  }
  const result: CanonicalProductRecord = {
    externalId,
    marketplace: ctx.marketplace,
    raw: stripped as Record<string, unknown>
  };
  const ts = stripped.lastModifiedDate ?? stripped.creationDate;
  if (ts) {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) result.modifiedAt = d;
  }
  return result;
}
```

- [ ] **Step 4: Register in normalizer index**

In `packages/connector-gateway/src/adapters/nango/normalize/index.ts`, find:

```ts
import { normalizeShopifyProduct } from "./shopify.js";
// ...
const REGISTRY: Partial<Record<Marketplace, Normalizer>> = {
  shopify: normalizeShopifyProduct
  // amazon, ebay, walmart, etsy — added per HLD phase
};
```

Replace with:

```ts
import { normalizeShopifyProduct } from "./shopify.js";
import { normalizeEbayRecord } from "./ebay.js";
// ...
const REGISTRY: Partial<Record<Marketplace, Normalizer>> = {
  shopify: normalizeShopifyProduct,
  ebay: normalizeEbayRecord
};
```

- [ ] **Step 5: Extend SYNC_NAMES for eBay**

In `packages/connector-gateway/src/adapters/nango/provider-key.ts`, find:

```ts
ebay: ["ebay-inventory-items"],
```

Replace with:

```ts
ebay: ["ebay-inventory-items", "ebay-orders", "ebay-offers"],
```

- [ ] **Step 6: Run normalizer tests**

```bash
cd packages/connector-gateway && bun test src/adapters/nango/normalize/ebay.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/connector-gateway/src/adapters/nango/normalize/ebay.ts \
        packages/connector-gateway/src/adapters/nango/normalize/ebay.test.ts \
        packages/connector-gateway/src/adapters/nango/normalize/index.ts \
        packages/connector-gateway/src/adapters/nango/provider-key.ts
git commit -m "feat(ebay): add eBay normalizer and extend SYNC_NAMES"
```

---

## Task 6: Create `EbayAdapter`

**Files:**
- Create: `packages/connector-gateway/src/adapters/ebay/adapter.ts`
- Create: `packages/connector-gateway/src/adapters/ebay/adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/connector-gateway/src/adapters/ebay/adapter.test.ts
import { describe, it, expect, spyOn } from 'bun:test';
import { EbayAdapter, NangoProxyEbayTransport, type EbayTransport } from './adapter.js';
import type { ConnectionContext } from '../../contract/provider-adapter.js';
import { GatewayError } from '@aonex/types';

const NANGO_HOST = 'https://api.nango.dev';
const adapter = new EbayAdapter({
  nangoConnectBaseUrl: 'https://connect.nango.dev',
  transport: new NangoProxyEbayTransport({
    nangoHost: NANGO_HOST,
    nangoSecretKey: 'test-secret',
    ebayApiBaseUrl: 'https://api.sandbox.ebay.com'
  })
});

const conn: ConnectionContext = {
  tenantId: 'tenant-1',
  merchantId: 'merchant-1' as any,
  marketplace: 'ebay',
  connectionId: 'conn-merchant-1-ebay'
};

describe('EbayAdapter.createOAuthUrl', () => {
  it('returns a Nango Connect URL containing the session token', async () => {
    const result = await adapter.createOAuthUrl({ merchantId: 'merchant-1' as any, sessionToken: 'sess_xyz' });
    expect(result.url).toContain('connect.nango.dev');
    expect(result.url).toContain('session_token=sess_xyz');
    expect(result.expiresAt).toBeInstanceOf(Date);
  });
});

describe('EbayAdapter.healthCheck', () => {
  it('delegates to transport and returns true on 200', async () => {
    const calls: string[] = [];
    const transport: EbayTransport = {
      request: async (_conn, path) => {
        calls.push(path);
        return new Response('{}', { status: 200 });
      }
    };
    const local = new EbayAdapter({ nangoConnectBaseUrl: 'https://connect.nango.dev', transport });
    const ok = await local.healthCheck({ connection: conn });
    expect(ok).toBe(true);
    expect(calls[0]).toBe('/sell/inventory/v1/inventory_item?limit=1');
  });

  it('returns false on non-200', async () => {
    const transport: EbayTransport = {
      request: async () => new Response('Unauthorized', { status: 401 })
    };
    const local = new EbayAdapter({ nangoConnectBaseUrl: 'https://connect.nango.dev', transport });
    expect(await local.healthCheck({ connection: conn })).toBe(false);
  });
});

describe('EbayAdapter.listProducts', () => {
  it('paginates via offset and returns ProviderProduct[]', async () => {
    let page = 0;
    const transport: EbayTransport = {
      request: async (_conn, path) => {
        page++;
        if (page === 1) {
          return new Response(JSON.stringify({
            inventoryItems: [{ sku: 'SKU-1', condition: 'NEW' }],
            total: 2,
            size: 1
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ inventoryItems: [{ sku: 'SKU-2', condition: 'NEW' }], total: 2, size: 1 }), { status: 200 });
      }
    };
    const local = new EbayAdapter({ nangoConnectBaseUrl: 'https://connect.nango.dev', transport });
    const result = await local.listProducts({ connection: conn, limit: 1 });
    expect(result).toHaveLength(2);
    expect(result[0]!.externalId).toBe('SKU-1');
    expect(result[1]!.externalId).toBe('SKU-2');
  });

  it('throws GatewayError on 4xx', async () => {
    const transport: EbayTransport = {
      request: async () => new Response('Forbidden', { status: 403 })
    };
    const local = new EbayAdapter({ nangoConnectBaseUrl: 'https://connect.nango.dev', transport });
    await expect(local.listProducts({ connection: conn })).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('EbayAdapter.getInventory', () => {
  it('returns quantity from shipToLocationAvailability', async () => {
    const transport: EbayTransport = {
      request: async () => new Response(JSON.stringify({
        sku: 'SKU-1',
        availability: { shipToLocationAvailability: { quantity: 42 } }
      }), { status: 200 })
    };
    const local = new EbayAdapter({ nangoConnectBaseUrl: 'https://connect.nango.dev', transport });
    const inv = await local.getInventory({ connection: conn, externalProductId: 'SKU-1' });
    expect(inv).toEqual([{ locationId: 'default', available: 42 }]);
  });

  it('returns [] on 404', async () => {
    const transport: EbayTransport = {
      request: async () => new Response('Not Found', { status: 404 })
    };
    const local = new EbayAdapter({ nangoConnectBaseUrl: 'https://connect.nango.dev', transport });
    expect(await local.getInventory({ connection: conn, externalProductId: 'MISSING' })).toEqual([]);
  });
});

describe('NangoProxyEbayTransport', () => {
  it('sends correct headers including Baseurl-Override', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const transport = new NangoProxyEbayTransport({
      nangoHost: NANGO_HOST,
      nangoSecretKey: 'secret-key',
      ebayApiBaseUrl: 'https://api.sandbox.ebay.com'
    });
    await transport.request(conn, '/sell/inventory/v1/inventory_item?limit=1');
    expect(spy).toHaveBeenCalledWith(
      `${NANGO_HOST}/proxy/sell/inventory/v1/inventory_item?limit=1`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer secret-key',
          'Connection-Id': conn.connectionId,
          'Provider-Config-Key': 'ebay',
          'Baseurl-Override': 'https://api.sandbox.ebay.com'
        })
      })
    );
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/connector-gateway && bun test src/adapters/ebay/adapter.test.ts
```

Expected: FAIL — module `./adapter.js` does not exist.

- [ ] **Step 3: Create `EbayAdapter`**

```ts
// packages/connector-gateway/src/adapters/ebay/adapter.ts
import type {
  ConnectionContext,
  MarketplaceLiveAdapter,
  ProviderProduct,
  ListProductsInput,
  GetInventoryByConnectionInput
} from '../../contract/provider-adapter.js';
import type { OAuthUrlResult, CreateOAuthUrlInput } from '../../contract/admin.js';
import type { InventoryRecord } from '../../contract/inventory.js';
import { GatewayError, type GatewayErrorKind } from '@aonex/types';

export interface EbayTransport {
  request(connection: ConnectionContext, path: string, init?: RequestInit): Promise<Response>;
}

export interface NangoProxyEbayTransportConfig {
  nangoHost: string;
  nangoSecretKey: string;
  ebayApiBaseUrl?: string;
}

export class NangoProxyEbayTransport implements EbayTransport {
  constructor(private readonly config: NangoProxyEbayTransportConfig) {}

  request(connection: ConnectionContext, path: string, init?: RequestInit): Promise<Response> {
    const baseUrl = this.config.ebayApiBaseUrl ?? 'https://api.ebay.com';
    return fetch(`${this.config.nangoHost}/proxy${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.config.nangoSecretKey}`,
        'Connection-Id': connection.connectionId,
        'Provider-Config-Key': 'ebay',
        'Baseurl-Override': baseUrl,
        ...(init?.headers as Record<string, string> ?? {})
      }
    });
  }
}

export interface EbayAdapterConfig {
  nangoConnectBaseUrl: string;
  transport: EbayTransport;
}

export class EbayAdapter implements MarketplaceLiveAdapter {
  constructor(private readonly config: EbayAdapterConfig) {}

  async createOAuthUrl(input: CreateOAuthUrlInput): Promise<OAuthUrlResult> {
    const url = `${this.config.nangoConnectBaseUrl}?session_token=${input.sessionToken}`;
    return { url, expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
  }

  async healthCheck(input: { connection: ConnectionContext }): Promise<boolean> {
    const res = await this.config.transport.request(
      input.connection,
      '/sell/inventory/v1/inventory_item?limit=1'
    );
    return res.ok;
  }

  async listProducts(input: ListProductsInput): Promise<ProviderProduct[]> {
    const limit = input.limit ?? 100;
    const maxPages = input.maxPages ?? 25;
    const products: ProviderProduct[] = [];
    let offset = 0;
    let page = 0;

    do {
      page++;
      const res = await this.config.transport.request(
        input.connection,
        `/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`
      );
      await assertOk(res, 'listProducts');
      const data = await res.json() as {
        inventoryItems?: Array<{ sku: string; [k: string]: unknown }>;
        total?: number;
      };
      for (const item of data.inventoryItems ?? []) {
        products.push({ externalId: item.sku, raw: item });
      }
      const total = data.total ?? 0;
      offset += limit;
      if (offset >= total) break;
    } while (page < maxPages);

    return products;
  }

  async getInventory(input: GetInventoryByConnectionInput): Promise<readonly InventoryRecord[]> {
    const res = await this.config.transport.request(
      input.connection,
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.externalProductId)}`
    );
    if (res.status === 404) return [];
    await assertOk(res, 'getInventory');
    const data = await res.json() as {
      availability?: { shipToLocationAvailability?: { quantity?: number } };
    };
    const quantity = data.availability?.shipToLocationAvailability?.quantity ?? 0;
    return [{ locationId: 'default', available: quantity }];
  }
}

async function assertOk(res: Response, operation: string): Promise<void> {
  if (res.ok) return;
  const body = await safeBody(res);
  const kind = kindForStatus(res.status);
  throw new GatewayError(kind, `eBay ${operation} failed with HTTP ${res.status}`, {
    providerStatus: res.status,
    ...(body ? { cause: body } : {})
  });
}

function kindForStatus(status: number): GatewayErrorKind {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_5xx';
  if (status >= 400) return 'provider_4xx';
  return 'internal';
}

async function safeBody(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()) || undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd packages/connector-gateway && bun test src/adapters/ebay/adapter.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Update `packages/connector-gateway/src/index.ts` exports**

Find the existing lines:

```ts
export { NangoProxyShopifyTransport, ShopifyAdapter } from "./adapters/shopify/adapter.js";
export type { ConnectionContext, MarketplaceLiveAdapter, ProviderProduct, ListProductsInput, ShopifyTransport } from "./adapters/shopify/adapter.js";
```

Replace with:

```ts
export { NangoProxyShopifyTransport, ShopifyAdapter } from "./adapters/shopify/adapter.js";
export type { ShopifyTransport } from "./adapters/shopify/adapter.js";
export { NangoProxyEbayTransport, EbayAdapter } from "./adapters/ebay/adapter.js";
export type { EbayTransport, EbayAdapterConfig, NangoProxyEbayTransportConfig } from "./adapters/ebay/adapter.js";
```

Note: `ConnectionContext`, `MarketplaceLiveAdapter`, `ProviderProduct`, `ListProductsInput` are now exported via `export * from "./contract/index.js"` (which includes `provider-adapter.ts`), so the explicit re-exports from shopify are removed to avoid duplication.

- [ ] **Step 6: Run full package typecheck**

```bash
cd packages/connector-gateway && bun run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/connector-gateway/src/adapters/ebay/ \
        packages/connector-gateway/src/index.ts
git commit -m "feat(ebay): add EbayAdapter and NangoProxyEbayTransport"
```

---

## Task 7: Create Nango sync scripts for eBay

**Files:**
- Create: `apps/nango/ebay/syncs/ebay-inventory-items.ts`
- Create: `apps/nango/ebay/syncs/ebay-orders.ts`
- Create: `apps/nango/ebay/syncs/ebay-offers.ts`
- Modify: `apps/nango/index.ts`

- [ ] **Step 1: Create `ebay-inventory-items.ts`**

```ts
// apps/nango/ebay/syncs/ebay-inventory-items.ts
import { createSync } from 'nango';
import { z } from 'zod';

const CheckpointSchema = z.object({
  fully_synced: z.string()  // 'true' after first full pull; re-syncs fully each run
});

const EbayInventoryItemSchema = z.object({
  id: z.string(),  // = sku; Nango uses `id` as the record key
  sku: z.string(),
  condition: z.string().nullable().optional(),
  locale: z.string().nullable().optional(),
  availability: z.object({
    shipToLocationAvailability: z.object({
      quantity: z.number()
    }).optional()
  }).nullable().optional(),
  product: z.object({
    title: z.string().optional(),
    description: z.string().optional()
  }).nullable().optional()
});

type EbayInventoryItem = z.infer<typeof EbayInventoryItemSchema>;

interface InventoryItemsResponse {
  inventoryItems?: Array<{ sku: string; [k: string]: unknown }>;
  total?: number;
  size?: number;
}

const LIMIT = 100;

const sync = createSync({
  description: 'Pulls eBay inventory items via Sell Inventory API v1 with offset pagination',
  version: '1.0.0',
  frequency: 'every 6 hours',
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: { EbayInventoryItem: EbayInventoryItemSchema },

  exec: async (nango) => {
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const res = await nango.get<InventoryItemsResponse>({
        endpoint: `/sell/inventory/v1/inventory_item?limit=${LIMIT}&offset=${offset}`,
        retries: 3
      });

      const items = res.data.inventoryItems ?? [];
      total = res.data.total ?? 0;

      const records: EbayInventoryItem[] = items.map((item) => ({
        id: item.sku,
        sku: item.sku,
        condition: (item.condition as string | undefined) ?? null,
        locale: (item.locale as string | undefined) ?? null,
        availability: (item.availability as EbayInventoryItem['availability']) ?? null,
        product: (item.product as EbayInventoryItem['product']) ?? null
      }));

      if (records.length > 0) {
        await nango.batchSave(records, 'EbayInventoryItem');
      }

      offset += LIMIT;
      if (items.length < LIMIT) break;
    }

    await nango.saveCheckpoint({ fully_synced: 'true' });
  }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
```

- [ ] **Step 2: Create `ebay-orders.ts`**

```ts
// apps/nango/ebay/syncs/ebay-orders.ts
import { createSync } from 'nango';
import { z } from 'zod';

const CheckpointSchema = z.object({
  created_after: z.string()
});

const MoneySchema = z.object({ value: z.string(), currency: z.string() });

const EbayOrderSchema = z.object({
  id: z.string(),  // = orderId
  orderId: z.string(),
  legacyOrderId: z.string().nullable().optional(),
  creationDate: z.string(),
  lastModifiedDate: z.string(),
  orderFulfillmentStatus: z.string(),
  orderPaymentStatus: z.string().nullable().optional(),
  pricingSummary: z.object({ total: MoneySchema }).nullable().optional()
});

type EbayOrder = z.infer<typeof EbayOrderSchema>;

interface OrdersResponse {
  orders?: Array<{
    orderId: string;
    legacyOrderId?: string;
    creationDate: string;
    lastModifiedDate: string;
    orderFulfillmentStatus: string;
    orderPaymentStatus?: string;
    pricingSummary?: { total: { value: string; currency: string } };
    [k: string]: unknown;
  }>;
  total?: number;
  next?: string;
}

const LIMIT = 50;

const sync = createSync({
  description: 'Pulls eBay orders via Sell Fulfillment API v1 with creationDate checkpoint',
  version: '1.0.0',
  frequency: 'every 1 hour',
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: { EbayOrder: EbayOrderSchema },

  exec: async (nango) => {
    const checkpoint = await nango.getCheckpoint();
    const createdAfter = checkpoint?.created_after ?? '';

    const filterParam = createdAfter
      ? `&filter=creationdate:[${createdAfter}..]`
      : '';

    let cursor: string | undefined;
    let latestDate = createdAfter;

    do {
      const cursorParam = cursor ? `&offset=${cursor}` : '';
      const res = await nango.get<OrdersResponse>({
        endpoint: `/sell/fulfillment/v1/order?limit=${LIMIT}${filterParam}${cursorParam}`,
        retries: 3
      });

      const orders = res.data.orders ?? [];

      const records: EbayOrder[] = orders.map((o) => ({
        id: o.orderId,
        orderId: o.orderId,
        legacyOrderId: o.legacyOrderId ?? null,
        creationDate: o.creationDate,
        lastModifiedDate: o.lastModifiedDate,
        orderFulfillmentStatus: o.orderFulfillmentStatus,
        orderPaymentStatus: o.orderPaymentStatus ?? null,
        pricingSummary: o.pricingSummary ?? null
      }));

      if (records.length > 0) {
        await nango.batchSave(records, 'EbayOrder');
        const last = records[records.length - 1];
        if (last && last.creationDate > latestDate) {
          latestDate = last.creationDate;
          await nango.saveCheckpoint({ created_after: latestDate });
        }
      }

      cursor = res.data.next ? String(records.length + (cursor ? Number(cursor) : 0)) : undefined;
    } while (cursor);
  }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
```

- [ ] **Step 3: Create `ebay-offers.ts`**

```ts
// apps/nango/ebay/syncs/ebay-offers.ts
import { createSync } from 'nango';
import { z } from 'zod';

const CheckpointSchema = z.object({
  fully_synced: z.string()
});

const EbayOfferSchema = z.object({
  id: z.string(),  // = offerId
  offerId: z.string(),
  sku: z.string(),
  marketplaceId: z.string(),
  format: z.string().nullable().optional(),
  availableQuantity: z.number().nullable().optional(),
  status: z.string(),
  listingId: z.string().nullable().optional(),
  pricingSummary: z.object({
    price: z.object({ value: z.string(), currency: z.string() })
  }).nullable().optional()
});

type EbayOffer = z.infer<typeof EbayOfferSchema>;

interface OffersResponse {
  offers?: Array<{
    offerId: string;
    sku: string;
    marketplaceId: string;
    format?: string;
    availableQuantity?: number;
    status: string;
    listingId?: string;
    pricingSummary?: { price: { value: string; currency: string } };
    [k: string]: unknown;
  }>;
  total?: number;
}

const LIMIT = 100;

const sync = createSync({
  description: 'Pulls eBay offers via Sell Inventory API v1 with offset pagination',
  version: '1.0.0',
  frequency: 'every 6 hours',
  autoStart: true,
  checkpoint: CheckpointSchema,
  models: { EbayOffer: EbayOfferSchema },

  exec: async (nango) => {
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const res = await nango.get<OffersResponse>({
        endpoint: `/sell/inventory/v1/offer?limit=${LIMIT}&offset=${offset}`,
        retries: 3
      });

      const offers = res.data.offers ?? [];
      total = res.data.total ?? 0;

      const records: EbayOffer[] = offers.map((o) => ({
        id: o.offerId,
        offerId: o.offerId,
        sku: o.sku,
        marketplaceId: o.marketplaceId,
        format: o.format ?? null,
        availableQuantity: o.availableQuantity ?? null,
        status: o.status,
        listingId: o.listingId ?? null,
        pricingSummary: o.pricingSummary ?? null
      }));

      if (records.length > 0) {
        await nango.batchSave(records, 'EbayOffer');
      }

      offset += LIMIT;
      if (offers.length < LIMIT) break;
    }

    await nango.saveCheckpoint({ fully_synced: 'true' });
  }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
```

- [ ] **Step 4: Update `apps/nango/index.ts`**

Find:

```ts
import './shopify/syncs/shopify-products.js';
```

Replace with:

```ts
import './shopify/syncs/shopify-products.js';
import './ebay/syncs/ebay-inventory-items.js';
import './ebay/syncs/ebay-orders.js';
import './ebay/syncs/ebay-offers.js';
```

- [ ] **Step 5: Typecheck the nango app**

```bash
cd apps/nango && bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/nango/ebay/ apps/nango/index.ts
git commit -m "feat(ebay): add Nango sync scripts for inventory items, orders, and offers"
```

---

## Task 8: Create eBay API routes

**Files:**
- Create: `apps/api/src/routes/ebay.ts`
- Create: `apps/api/src/routes/ebay.test.ts`
- Modify: `apps/api/src/composition-root.ts`

- [ ] **Step 1: Write the failing route tests**

```ts
// apps/api/src/routes/ebay.test.ts
import { describe, it, expect } from 'bun:test';
import { ebayRoutes } from './ebay.js';
import { QUEUE } from '@aonex/types';

function makeGateway() {
  return {
    createOAuthUrl: async () => ({ url: 'https://connect.nango.dev?session_token=t', expiresAt: new Date('2030-01-01') }),
    getConnection: async () => ({ marketplace: 'ebay', status: 'active', scopes: [] }),
    listRecords: async () => ({ page: { records: [{ externalId: 'SKU-1', marketplace: 'ebay', raw: { sku: 'SKU-1' } }] } })
  };
}

function makeAudit() { return { emit: async () => {} }; }

function makeTriggerQueue() {
  const added: string[] = [];
  return {
    add: (_kind: string, _data: unknown, opts: { jobId: string }) => {
      added.push(opts.jobId);
      return Promise.resolve();
    },
    _added: added
  };
}

async function callRoute(
  app: ReturnType<typeof ebayRoutes>,
  method: string,
  path: string
) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'x-merchant-id': 'merchant-1', 'x-tenant-id': 'tenant-1' }
  });
  return app.fetch(req, { merchantId: 'merchant-1', tenantId: 'tenant-1', requestId: 'req-1' });
}

describe('POST /connect', () => {
  it('returns OAuth URL', async () => {
    const app = ebayRoutes({
      gateway: makeGateway() as any,
      audit: makeAudit() as any,
      queues: { [QUEUE.NANGO_TRIGGER]: makeTriggerQueue() as any }
    });
    const res = await callRoute(app, 'POST', '/connect');
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.data.url).toContain('session_token=');
  });
});

describe('GET /callback', () => {
  it('returns connection status and enqueues sync', async () => {
    const queue = makeTriggerQueue();
    const app = ebayRoutes({
      gateway: makeGateway() as any,
      audit: makeAudit() as any,
      queues: { [QUEUE.NANGO_TRIGGER]: queue as any }
    });
    const res = await callRoute(app, 'GET', '/callback');
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.data.marketplace).toBe('ebay');
    expect(queue._added).toContain('initial:merchant-1:ebay');
  });

  it('returns 404 when connection not found', async () => {
    const gateway = { ...makeGateway(), getConnection: async () => null };
    const app = ebayRoutes({
      gateway: gateway as any,
      audit: makeAudit() as any,
      queues: { [QUEUE.NANGO_TRIGGER]: makeTriggerQueue() as any }
    });
    const res = await callRoute(app, 'GET', '/callback');
    expect(res.status).toBe(404);
  });
});

describe('GET /inventory', () => {
  it('returns records from listRecords', async () => {
    const app = ebayRoutes({
      gateway: makeGateway() as any,
      audit: makeAudit() as any,
      queues: { [QUEUE.NANGO_TRIGGER]: makeTriggerQueue() as any }
    });
    const res = await callRoute(app, 'GET', '/inventory');
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].externalId).toBe('SKU-1');
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
cd apps/api && bun test src/routes/ebay.test.ts
```

Expected: FAIL — `ebayRoutes` does not exist.

- [ ] **Step 3: Create the routes**

```ts
// apps/api/src/routes/ebay.ts
import { Hono } from 'hono';
import { MerchantId, TenantId, JOB_KIND, QUEUE, STANDARD_RETRY } from '@aonex/types';
import type { AuditEmitter } from '@aonex/audit';
import type { Queue } from 'bullmq';
import type { ConnectorGateway } from '@aonex/connector-gateway';

export interface EbayRouteDeps {
  gateway: ConnectorGateway;
  audit: AuditEmitter;
  queues: { [QUEUE.NANGO_TRIGGER]: Queue };
}

export function ebayRoutes(deps: EbayRouteDeps): Hono {
  const app = new Hono();

  // POST /connect — creates a Nango Connect session and returns the OAuth URL.
  app.post('/connect', async (c) => {
    const merchantId = MerchantId.unsafeFrom(c.get('merchantId') as string);
    const tenantId = TenantId.unsafeFrom(c.get('tenantId') as string);

    const { url, expiresAt } = await deps.gateway.createOAuthUrl(merchantId, tenantId, 'ebay');

    await deps.audit.emit({
      tenantId,
      merchantId,
      actorId: merchantId,
      actorType: 'user',
      eventType: 'connection.session.created',
      entityType: 'merchant',
      entityId: merchantId,
      metadata: { marketplace: 'ebay' },
      requestId: c.get('requestId') as string
    });

    return c.json({ data: { url, expiresAt: expiresAt.toISOString() } });
  });

  // GET /callback — confirm connection exists, enqueue initial sync.
  app.get('/callback', async (c) => {
    const merchantId = MerchantId.unsafeFrom(c.get('merchantId') as string);
    const tenantId = TenantId.unsafeFrom(c.get('tenantId') as string);

    const conn = await deps.gateway.getConnection({ merchantId, marketplace: 'ebay' });
    if (!conn) {
      return c.json({ error: { code: 'CONNECTION_NOT_FOUND' } }, 404);
    }

    await deps.queues[QUEUE.NANGO_TRIGGER].add(
      JOB_KIND.INITIAL_SYNC,
      { merchantId, marketplace: 'ebay', tenantId },
      { jobId: `initial:${merchantId}:ebay`, ...STANDARD_RETRY }
    );

    return c.json({ data: { status: conn.status, marketplace: 'ebay' } });
  });

  // GET /inventory — drain Nango cache for ebay-inventory-items.
  app.get('/inventory', async (c) => {
    const merchantId = MerchantId.unsafeFrom(c.get('merchantId') as string);
    const result = await deps.gateway.listRecords({
      merchantId,
      marketplace: 'ebay',
      model: 'ebay-inventory-items'
    });
    return c.json({ data: result.page.records });
  });

  // GET /orders — drain Nango cache for ebay-orders.
  app.get('/orders', async (c) => {
    const merchantId = MerchantId.unsafeFrom(c.get('merchantId') as string);
    const result = await deps.gateway.listRecords({
      merchantId,
      marketplace: 'ebay',
      model: 'ebay-orders'
    });
    return c.json({ data: result.page.records });
  });

  // GET /offers — drain Nango cache for ebay-offers.
  app.get('/offers', async (c) => {
    const merchantId = MerchantId.unsafeFrom(c.get('merchantId') as string);
    const result = await deps.gateway.listRecords({
      merchantId,
      marketplace: 'ebay',
      model: 'ebay-offers'
    });
    return c.json({ data: result.page.records });
  });

  return app;
}
```

- [ ] **Step 4: Run route tests**

```bash
cd apps/api && bun test src/routes/ebay.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Wire into `composition-root.ts`**

In `apps/api/src/composition-root.ts`:

**a) Add import at the top with other imports:**
```ts
import { ebayRoutes } from "./routes/ebay.js";
```

**b) After the existing Shopify adapter instantiation, add the eBay adapter:**
```ts
import { ..., EbayAdapter, NangoProxyEbayTransport } from "@aonex/connector-gateway";
```

Add to the existing import line from `@aonex/connector-gateway`:
```ts
import {
  buildGateway,
  type ConnectorAdapterPhase1,
  ShopifyAdapter,
  ConnectorGateway,
  NangoProxyShopifyTransport,
  NangoProxyEbayTransport,
  EbayAdapter,
  PostgresConnectionRegistry
} from "@aonex/connector-gateway";
```

**c) After `shopifyAdapter` instantiation, add:**
```ts
const ebayAdapter = new EbayAdapter({
  nangoConnectBaseUrl: env.NANGO_CONNECT_BASE_URL,
  transport: new NangoProxyEbayTransport({
    nangoHost: env.NANGO_HOST,
    nangoSecretKey: env.NANGO_SECRET_KEY,
    ebayApiBaseUrl: env.EBAY_API_BASE_URL
  })
});
```

**d) Update `ConnectorGateway` instantiation to include eBay:**
```ts
const connectorGateway = new ConnectorGateway({
  lookup: connectionRegistry,
  nango: gateway,
  marketplaceAdapters: {
    shopify: shopifyAdapter,
    ebay: ebayAdapter
  }
});
```

**e) Mount the eBay routes (after the Shopify route mount):**
```ts
protectedApp.route(
  '/marketplaces/ebay',
  ebayRoutes({
    gateway: connectorGateway,
    audit,
    queues: { [QUEUE.NANGO_TRIGGER]: nangoTriggerQueue }
  })
);
```

- [ ] **Step 6: Add `EBAY_API_BASE_URL` to the env schema**

Find where `NANGO_CONNECT_BASE_URL` is defined in `packages/types/src/env.ts` (or wherever `parseEnv` / `Env` is defined) and add:

```ts
EBAY_API_BASE_URL: z.string().url().default('https://api.ebay.com'),
```

This defaults to production but can be overridden to `https://api.sandbox.ebay.com` in `.env`.

- [ ] **Step 7: Typecheck the API app**

```bash
cd apps/api && bun run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/ebay.ts \
        apps/api/src/routes/ebay.test.ts \
        apps/api/src/composition-root.ts \
        packages/types/src/env.ts
git commit -m "feat(ebay): add eBay API routes and wire composition root"
```

---

## Task 9: Full test suite + final typecheck

- [ ] **Step 1: Run full connector-gateway test suite**

```bash
cd packages/connector-gateway && bun test
```

Expected: all tests pass (existing Shopify tests + new eBay/normalizer/model-override tests).

- [ ] **Step 2: Run full API test suite**

```bash
cd apps/api && bun test
```

Expected: all tests pass including new eBay route tests.

- [ ] **Step 3: Run workspace-wide typecheck**

```bash
bun run typecheck
```

Expected: no errors across all packages.

- [ ] **Step 4: Final commit if any loose files**

```bash
git status  # verify nothing untracked
```

---

## Environment Variables Reference

Add to `.env` for sandbox testing:

```env
EBAY_API_BASE_URL=https://api.sandbox.ebay.com
```

Add to `.env` for production:

```env
EBAY_API_BASE_URL=https://api.ebay.com
```

## Nango Dashboard Setup

In your Nango dashboard, create an integration called `ebay` with:
- **Client ID:** `DhruvPat-aonex-SBX-0183ec2e3-c8102afa`
- **Client Secret:** (from your eBay developer account)
- **Scopes:**
  - `https://api.ebay.com/oauth/api_scope`
  - `https://api.ebay.com/oauth/api_scope/sell.inventory`
  - `https://api.ebay.com/oauth/api_scope/sell.fulfillment`
  - `https://api.ebay.com/oauth/api_scope/sell.marketing`
- **RuName (callback):** `Dhruv_Patel-DhruvPat-aonex--lubrsd`
- **Sandbox:** enabled
