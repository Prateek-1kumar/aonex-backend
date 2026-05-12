// /api/marketplaces/shopify — Shopify-specific connect + callback + products.
//
// WHY THESE ROUTES EXIST SEPARATELY:
// The /api/connections routes use the Nango Connect UI flow (generic).
// These routes expose the ShopifyAdapter-specific surface: explicit OAuth
// URL generation, post-OAuth callback confirmation, and direct product listing
// via the ConnectorGateway (ShopifyAdapter path, not Nango cache drain).

import { Hono } from 'hono';
import { MerchantId, TenantId, JOB_KIND, QUEUE, STANDARD_RETRY } from '@aonex/types';
import type { ConnectorGateway } from '@aonex/connector-gateway';
import type { AuditEmitter } from '@aonex/audit';
import type { Queue } from 'bullmq';

export interface ShopifyRouteDeps {
  gateway: ConnectorGateway;
  audit: AuditEmitter;
  queues: { [QUEUE.NANGO_TRIGGER]: Queue };
}

export function shopifyRoutes(deps: ShopifyRouteDeps): Hono {
  const app = new Hono();

  // POST /connect
  // Creates a Nango Connect session and returns the OAuth URL for the frontend.
  app.post('/connect', async (c) => {
    const merchantId = MerchantId.unsafeFrom(c.get('merchantId') as string);
    const tenantId = TenantId.unsafeFrom(c.get('tenantId') as string);

    const { url, expiresAt } = await deps.gateway.createOAuthUrl(merchantId, tenantId, 'shopify');

    await deps.audit.emit({
      tenantId,
      merchantId,
      actorId: merchantId,
      actorType: 'user',
      eventType: 'connection.session.created',
      entityType: 'merchant',
      entityId: merchantId,
      metadata: { marketplace: 'shopify' },
      requestId: c.get('requestId') as string
    });

    return c.json({ data: { url, expiresAt: expiresAt.toISOString() } });
  });

  // GET /callback
  // Landing page after Nango Connect OAuth completes. Confirms the connection
  // exists (auth webhook may have already fired) and enqueues initial sync.
  app.get('/callback', async (c) => {
    const merchantId = MerchantId.unsafeFrom(c.get('merchantId') as string);
    const tenantId = TenantId.unsafeFrom(c.get('tenantId') as string);

    const conn = await deps.gateway.getConnection({ merchantId, marketplace: 'shopify' });
    if (!conn) {
      return c.json({ error: { code: 'CONNECTION_NOT_FOUND' } }, 404);
    }

    await deps.queues[QUEUE.NANGO_TRIGGER].add(
      JOB_KIND.INITIAL_SYNC,
      { merchantId, marketplace: 'shopify', tenantId },
      { jobId: `initial:${merchantId}:shopify`, ...STANDARD_RETRY }
    );

    return c.json({ data: { status: conn.status, marketplace: 'shopify' } });
  });

  // GET /products
  // Direct product listing via ShopifyAdapter (provider-native path).
  // Use this for on-demand reads; the Nango drain path feeds source_artifacts.
  app.get('/products', async (c) => {
    const merchantId = MerchantId.unsafeFrom(c.get('merchantId') as string);
    const products = await deps.gateway.listProducts(merchantId, 'shopify');
    return c.json({ data: products });
  });

  return app;
}
