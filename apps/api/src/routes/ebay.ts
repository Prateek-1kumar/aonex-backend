import { Hono } from 'hono';
import type { Context } from 'hono';
import { MerchantId, TenantId, JOB_KIND, QUEUE, STANDARD_RETRY } from '@aonex/types';
import type { AuditEmitter } from '@aonex/audit';
import type { Queue } from 'bullmq';
import type { ConnectorGateway } from '@aonex/connector-gateway';

export interface EbayRouteDeps {
  gateway: ConnectorGateway;
  audit: AuditEmitter;
  queues: { [QUEUE.NANGO_TRIGGER]: Queue };
}

// Helper: reads a context variable set by auth middleware, falling back to
// the Hono env bindings (only present in tests / non-JWT environments).
function ctxGet(c: Context, key: string): string {
  return (c.get(key as never) ?? (c.env as Record<string, unknown> | undefined)?.[key]) as string;
}

export function ebayRoutes(deps: EbayRouteDeps): Hono {
  const app = new Hono();

  app.post('/connect', async (c) => {
    const merchantId = MerchantId.unsafeFrom(ctxGet(c,'merchantId'));
    const tenantId = TenantId.unsafeFrom(ctxGet(c,'tenantId'));

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
      requestId: ctxGet(c,'requestId')
    });

    return c.json({ data: { url, expiresAt: expiresAt.toISOString() } });
  });

  app.get('/callback', async (c) => {
    const merchantId = MerchantId.unsafeFrom(ctxGet(c,'merchantId'));
    const tenantId = TenantId.unsafeFrom(ctxGet(c,'tenantId'));

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

  app.get('/inventory', async (c) => {
    const merchantId = MerchantId.unsafeFrom(ctxGet(c,'merchantId'));
    const products = await deps.gateway.listProducts(merchantId, 'ebay');
    return c.json({ data: products });
  });

  app.get('/orders', async (c) => {
    const merchantId = MerchantId.unsafeFrom(ctxGet(c,'merchantId'));
    const result = await deps.gateway.listRecords({
      merchantId,
      marketplace: 'ebay',
      model: 'ebay-orders'
    });
    return c.json({ data: result.page.records });
  });

  app.get('/offers', async (c) => {
    const merchantId = MerchantId.unsafeFrom(ctxGet(c,'merchantId'));
    const result = await deps.gateway.listRecords({
      merchantId,
      marketplace: 'ebay',
      model: 'ebay-offers'
    });
    return c.json({ data: result.page.records });
  });

  return app;
}
