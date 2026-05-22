import { describe, it } from 'bun:test';
import { shopifyRoutes } from './shopify.js';
import { QUEUE } from '@aonex/types';

describe('debug', () => {
  it('shows what jobId is added', async () => {
    const added: string[] = [];
    const queue = {
      add: (_kind: string, _data: unknown, opts: { jobId: string }) => {
        added.push(opts.jobId);
        console.log('jobId added:', opts.jobId);
        return Promise.resolve();
      },
      _added: added
    };
    
    const app = shopifyRoutes({
      gateway: {
        createOAuthUrl: async () => ({ url: 'https://connect.nango.dev?session_token=t', expiresAt: new Date('2030-01-01') }),
        getConnection: async () => ({ marketplace: 'shopify', status: 'active', scopes: [] }),
        listProducts: async () => []
      } as any,
      audit: { emit: async () => {} } as any,
      queues: { [QUEUE.NANGO_TRIGGER]: queue as any }
    });
    
    const req = new Request('http://localhost/callback', {
      method: 'GET',
      headers: { 'x-merchant-id': 'merchant-1', 'x-tenant-id': 'tenant-1' }
    });
    const res = await app.fetch(req, { merchantId: 'merchant-1', tenantId: 'tenant-1', requestId: 'req-1' } as any);
    const body = await res.json();
    console.log('status:', res.status);
    console.log('body:', JSON.stringify(body));
    console.log('added:', JSON.stringify(added));
  });
});
