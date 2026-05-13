import { describe, it, expect, spyOn } from 'bun:test';
import { ConnectorGateway } from './gateway.js';
import { NangoProxyShopifyTransport, ShopifyAdapter } from './adapters/shopify/adapter.js';
import type { MarketplaceLiveAdapter } from './adapters/shopify/adapter.js';

function makeMockDb(row: Record<string, unknown> | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : [])
        })
      })
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve()
      })
    })
  };
}

function makeShopifyAdapter() {
  return new ShopifyAdapter({
    nangoConnectBaseUrl: 'https://connect.nango.dev',
    transport: new NangoProxyShopifyTransport({
      nangoHost: 'https://api.nango.dev',
      nangoSecretKey: 'test-secret'
    })
  });
}

const mockNango = {
  createConnectSession: async () => ({ token: 'sess_123', expiresAt: new Date() }),
  getConnection: async () => null,
  listConnections: async () => [],
  revoke: async () => {},
  refreshTokenHealth: async () => ({ healthy: true }),
  verifyAndParseWebhook: async () => ({ event: {}, webhookId: 'wh_1' }),
  drainProducts: async function* () {},
  getSyncStatus: async () => ({ marketplace: 'shopify' as const })
} as any;

describe('ConnectorGateway.loadConnection', () => {
  it('returns ConnectionContext with connectionId', async () => {
    const db = makeMockDb({
      tenantId: 'tenant-1',
      merchantId: 'merchant-1',
      marketplace: 'shopify',
      providerConnectionId: 'nango-conn-abc',
      status: 'active'
    }) as any;

    const gateway = new ConnectorGateway({ db, nango: mockNango, marketplaceAdapters: { shopify: makeShopifyAdapter() } });
    const ctx = await gateway.loadConnection('merchant-1' as any, 'shopify');
    expect(ctx.connectionId).toBe('nango-conn-abc');
    expect(ctx.tenantId).toBe('tenant-1');
  });

  it('throws when connection not found', async () => {
    const db = makeMockDb(null) as any;
    const gateway = new ConnectorGateway({ db, nango: mockNango, marketplaceAdapters: { shopify: makeShopifyAdapter() } });
    await expect(gateway.loadConnection('merchant-x' as any, 'shopify')).rejects.toThrow();
  });
});

describe('ConnectorGateway.listProducts', () => {
  it('depends on a marketplace adapter interface, not the concrete ShopifyAdapter class', async () => {
    const db = makeMockDb({
      tenantId: 'tenant-1',
      merchantId: 'merchant-1',
      marketplace: 'shopify',
      providerConnectionId: 'nango-conn-abc',
      status: 'active'
    }) as any;
    const liveAdapter: MarketplaceLiveAdapter = {
      createOAuthUrl: async () => ({ url: 'https://connect.example', expiresAt: new Date() }),
      healthCheck: async () => true,
      listProducts: async () => [{ externalId: 'p1', raw: { id: 'p1' } }],
      getInventory: async () => []
    };

    const gateway = new ConnectorGateway({
      db,
      nango: mockNango,
      marketplaceAdapters: { shopify: liveAdapter }
    });

    await expect(gateway.listProducts('merchant-1' as any, 'shopify')).resolves.toEqual([
      { externalId: 'p1', raw: { id: 'p1' } }
    ]);
  });

  it('routes to ShopifyAdapter and returns products', async () => {
    const db = makeMockDb({
      tenantId: 'tenant-1',
      merchantId: 'merchant-1',
      marketplace: 'shopify',
      providerConnectionId: 'nango-conn-abc',
      status: 'active'
    }) as any;

    const shopify = makeShopifyAdapter();
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ products: [{ id: 1, title: 'Test' }] }), { status: 200 })
    );

    const gateway = new ConnectorGateway({ db, nango: mockNango, marketplaceAdapters: { shopify } });
    const products = await gateway.listProducts('merchant-1' as any, 'shopify');
    expect(products).toHaveLength(1);
    expect(products[0]!.externalId).toBe('1');
    spy.mockRestore();
  });

  it('throws UNSUPPORTED_MARKETPLACE for unknown marketplace', async () => {
    const db = makeMockDb({
      tenantId: 'tenant-1', merchantId: 'merchant-1',
      marketplace: 'amazon', providerConnectionId: 'conn-1', status: 'active'
    }) as any;
    const gateway = new ConnectorGateway({ db, nango: mockNango, marketplaceAdapters: { shopify: makeShopifyAdapter() } });
    await expect(gateway.listProducts('merchant-1' as any, 'amazon' as any)).rejects.toThrow('UNSUPPORTED_MARKETPLACE');
  });
});
