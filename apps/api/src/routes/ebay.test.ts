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
