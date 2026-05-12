import { describe, it, expect } from 'bun:test';
import { shopifyRoutes } from './shopify.js';
import { QUEUE } from '@aonex/types';

function makeDefaultGateway() {
  return {
    createOAuthUrl: async () => ({ url: 'https://connect.nango.dev?session_token=t', expiresAt: new Date('2030-01-01') }),
    getConnection: async () => ({ marketplace: 'shopify', status: 'active', scopes: [] }),
    listProducts: async () => [{ externalId: 'prod-1', raw: { id: 1, title: 'Widget' } }]
  };
}

function makeAudit() {
  return { emit: async () => {} };
}

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
  app: ReturnType<typeof shopifyRoutes>,
  method: string,
  path: string,
  headers: Record<string, string> = {}
) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      'x-merchant-id': 'merchant-1',
      'x-tenant-id': 'tenant-1',
      ...headers
    }
  });
  // Inject Hono context variables via env bindings (test pattern)
  return app.fetch(req, { merchantId: 'merchant-1', tenantId: 'tenant-1', requestId: 'req-1' });
}

describe('POST /connect', () => {
  it('returns OAuth URL and expiresAt', async () => {
    const queue = makeTriggerQueue();
    const app = shopifyRoutes({
      gateway: makeDefaultGateway() as any,
      audit: makeAudit() as any,
      queues: { [QUEUE.NANGO_TRIGGER]: queue as any }
    });
    const res = await callRoute(app, 'POST', '/connect');
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.data.url).toContain('session_token=');
    expect(body.data.expiresAt).toBeDefined();
  });
});

describe('GET /callback', () => {
  it('returns 200 with connection status when connection exists', async () => {
    const queue = makeTriggerQueue();
    const app = shopifyRoutes({
      gateway: makeDefaultGateway() as any,
      audit: makeAudit() as any,
      queues: { [QUEUE.NANGO_TRIGGER]: queue as any }
    });
    const res = await callRoute(app, 'GET', '/callback');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('active');
  });

  it('returns 404 when no connection found', async () => {
    const queue = makeTriggerQueue();
    const app = shopifyRoutes({
      gateway: { ...makeDefaultGateway(), getConnection: async () => null } as any,
      audit: makeAudit() as any,
      queues: { [QUEUE.NANGO_TRIGGER]: queue as any }
    });
    const res = await callRoute(app, 'GET', '/callback');
    expect(res.status).toBe(404);
  });
});

describe('GET /products', () => {
  it('returns product list', async () => {
    const queue = makeTriggerQueue();
    const app = shopifyRoutes({
      gateway: makeDefaultGateway() as any,
      audit: makeAudit() as any,
      queues: { [QUEUE.NANGO_TRIGGER]: queue as any }
    });
    const res = await callRoute(app, 'GET', '/products');
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].externalId).toBe('prod-1');
  });
});
