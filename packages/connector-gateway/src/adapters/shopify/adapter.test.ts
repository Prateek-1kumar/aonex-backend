import { describe, it, expect, spyOn } from 'bun:test';
import { NangoProxyShopifyTransport, ShopifyAdapter, type ShopifyTransport } from './adapter.js';
import type { ConnectionContext } from './adapter.js';
import { GatewayError } from '@aonex/types';

const NANGO_HOST = 'https://api.nango.dev';
const adapter = new ShopifyAdapter({
  nangoConnectBaseUrl: 'https://connect.nango.dev',
  transport: new NangoProxyShopifyTransport({
    nangoHost: NANGO_HOST,
    nangoSecretKey: 'test-secret-key'
  })
});

const conn: ConnectionContext = {
  tenantId: 'tenant-1',
  merchantId: 'merchant-1' as any,
  marketplace: 'shopify',
  connectionId: 'conn-merchant-1-shopify'
};

describe('ShopifyAdapter.createOAuthUrl', () => {
  it('returns a Nango Connect URL containing the session token', async () => {
    const result = await adapter.createOAuthUrl({ merchantId: 'merchant-1' as any, sessionToken: 'sess_abc' });
    expect(result.url).toContain('connect.nango.dev');
    expect(result.url).toContain('session_token=sess_abc');
    expect(result.expiresAt).toBeInstanceOf(Date);
  });
});

describe('ShopifyAdapter.healthCheck', () => {
  it('delegates provider requests to the injected transport', async () => {
    const calls: Array<{ connection: ConnectionContext; path: string; init?: RequestInit }> = [];
    const transport: ShopifyTransport = {
      request: async (connection, path, init) => {
        calls.push({
          connection,
          path,
          ...(init ? { init } : {})
        });
        return new Response(JSON.stringify({ shop: { id: 1 } }), { status: 200 });
      }
    };
    const localAdapter = new ShopifyAdapter({
      nangoConnectBaseUrl: 'https://connect.nango.dev',
      transport
    });

    const result = await localAdapter.healthCheck({ connection: conn });

    expect(result).toBe(true);
    expect(calls).toEqual([
      {
        connection: conn,
        path: '/admin/api/2025-01/shop.json'
      }
    ]);
  });

  it('returns true when Shopify shop.json responds 200', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ shop: { id: 1 } }), { status: 200 })
    );
    const result = await adapter.healthCheck({ connection: conn });
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      `${NANGO_HOST}/proxy/admin/api/2025-01/shop.json`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-secret-key',
          'Connection-Id': conn.connectionId,
          'Provider-Config-Key': 'shopify'
        })
      })
    );
    spy.mockRestore();
  });

  it('returns false when Shopify responds non-200', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const result = await adapter.healthCheck({ connection: conn });
    expect(result).toBe(false);
    spy.mockRestore();
  });
});

describe('ShopifyAdapter.listProducts', () => {
  it('returns ProviderProduct[] with externalId and raw', async () => {
    const mockProducts = [
      { id: 12345, title: 'Test Product', handle: 'test-product' }
    ];
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ products: mockProducts }), { status: 200 })
    );
    const result = await adapter.listProducts({ connection: conn });
    expect(result).toHaveLength(1);
    expect(result[0]!.externalId).toBe('12345');
    expect(result[0]!.raw).toEqual(mockProducts[0]);
    spy.mockRestore();
  });

  it('follows Shopify REST pagination and aggregates all product pages', async () => {
    const spy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ products: [{ id: 1, title: 'Page 1' }] }), {
          status: 200,
          headers: {
            Link: '<https://shop.myshopify.com/admin/api/2025-01/products.json?limit=1&page_info=next-token>; rel="next"'
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ products: [{ id: 2, title: 'Page 2' }] }), { status: 200 })
      );

    const result = await adapter.listProducts({ connection: conn, limit: 1 });

    expect(result.map((p) => p.externalId)).toEqual(['1', '2']);
    expect(spy).toHaveBeenNthCalledWith(
      2,
      `${NANGO_HOST}/proxy/admin/api/2025-01/products.json?limit=1&page_info=next-token`,
      expect.any(Object)
    );
    spy.mockRestore();
  });

  it('throws normalized GatewayError on Shopify provider failure', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('server down', { status: 500, statusText: 'Server Error' })
    );
    try {
      await adapter.listProducts({ connection: conn });
      throw new Error('expected listProducts to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).kind).toBe('provider_5xx');
      expect((err as GatewayError).providerStatus).toBe(500);
    }
    spy.mockRestore();
  });

  it('preserves Shopify retry-after when rate limited', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } })
    );
    try {
      await adapter.listProducts({ connection: conn });
      throw new Error('expected listProducts to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).kind).toBe('rate_limited');
      expect((err as GatewayError).retryAfterMs).toBe(2000);
    }
    spy.mockRestore();
  });
});

describe('ShopifyAdapter.getInventory', () => {
  it('extracts inventoryQuantity from product variants', async () => {
    const mockProduct = {
      id: 12345,
      variants: [
        { id: 1, inventoryQuantity: 10 },
        { id: 2, inventoryQuantity: 5 }
      ]
    };
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ product: mockProduct }), { status: 200 })
    );
    const result = await adapter.getInventory({ connection: conn, externalProductId: '12345' });
    expect(result).toHaveLength(2);
    expect(result[0]!.available).toBe(10);
    expect(result[1]!.available).toBe(5);
    spy.mockRestore();
  });
});
