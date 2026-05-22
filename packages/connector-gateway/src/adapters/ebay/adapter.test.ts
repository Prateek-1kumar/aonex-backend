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

  it('stops fetching when offset reaches total', async () => {
    const requestPaths: string[] = [];
    const transport: EbayTransport = {
      request: async (_conn, path) => {
        requestPaths.push(path);
        return new Response(JSON.stringify({
          inventoryItems: [{ sku: `SKU-${requestPaths.length}`, condition: 'NEW' }],
          total: 2,
          size: 1
        }), { status: 200 });
      }
    };
    const local = new EbayAdapter({ nangoConnectBaseUrl: 'https://connect.nango.dev', transport });
    const result = await local.listProducts({ connection: conn, limit: 1 });
    expect(result).toHaveLength(2);
    expect(requestPaths).toHaveLength(2);  // exactly 2 requests, no extra
    expect(requestPaths[0]).toContain('offset=0');
    expect(requestPaths[1]).toContain('offset=1');
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
