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

    try {
      await adapter.listRecords({
        merchantId: 'merchant-1' as any,
        marketplace: 'shopify',
        model: 'custom-model'
      });
    } catch {
      // Expected to fail due to missing normalizer, but capturedModel should be set
    }

    expect(capturedModel).toBe('custom-model');
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

    try {
      await adapter.listRecords({
        merchantId: 'merchant-1' as any,
        marketplace: 'shopify'
      });
    } catch {
      // Expected to fail due to missing normalizer, but capturedModel should be set
    }

    expect(capturedModel).toBe('shopify-products');
  });
});
