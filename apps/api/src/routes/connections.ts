// /api/connections — Nango Connect handshake start/list/revoke.
// LLD §5.1 sequence: server creates connect session, client opens
// Nango Connect UI, Nango fires auth webhook, worker activates.

import { Hono } from "hono";
import { z } from "zod";
import {
  isMarketplace,
  MARKETPLACES,
  MerchantId,
  TenantId,
  type Marketplace
} from "@aonex/types";
import type { ConnectorAdapterPhase1 } from "@aonex/connector-gateway";
import type { AuditEmitter } from "@aonex/audit";

export interface ConnectionsDeps {
  gateway: ConnectorAdapterPhase1;
  audit: AuditEmitter;
}

const CreateBody = z.object({
  marketplaces: z.array(z.enum(MARKETPLACES)).min(1)
});

export function connectionsRoutes(deps: ConnectionsDeps): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = CreateBody.parse(await c.req.json());
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId") as string);
    const tenantId = TenantId.unsafeFrom(c.get("tenantId") as string);
    const session = await deps.gateway.createConnectSession({
      tenantId,
      merchantId,
      marketplaces: body.marketplaces as readonly Marketplace[]
    });
    await deps.audit.emit({
      tenantId,
      merchantId,
      actorId: merchantId,
      actorType: "user",
      eventType: "connection.session.created",
      entityType: "merchant",
      entityId: merchantId,
      metadata: { marketplaces: body.marketplaces },
      requestId: c.get("requestId") as string
    });
    return c.json({ data: { token: session.token, expiresAt: session.expiresAt.toISOString() } });
  });

  app.get("/", async (c) => {
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId") as string);
    const conns = await deps.gateway.listConnections({ merchantId });
    return c.json({
      data: conns.map((c) => ({
        marketplace: c.marketplace,
        status: c.status,
        scopes: c.scopes,
        connectedAt: c.connectedAt?.toISOString(),
        lastTokenRefreshAt: c.lastTokenRefreshAt?.toISOString()
      }))
    });
  });

  app.delete("/:marketplace", async (c) => {
    const mp = c.req.param("marketplace");
    if (!isMarketplace(mp)) {
      return c.json({ error: { code: "INVALID_MARKETPLACE" } }, 400);
    }
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId") as string);
    const tenantId = TenantId.unsafeFrom(c.get("tenantId") as string);
    await deps.gateway.revoke({ merchantId, marketplace: mp });
    await deps.audit.emit({
      tenantId,
      merchantId,
      actorId: merchantId,
      actorType: "user",
      eventType: "connection.revoked",
      entityType: "marketplace_connection",
      entityId: `${merchantId}:${mp}`,
      requestId: c.get("requestId") as string
    });
    return c.json({ data: { ok: true } });
  });

  return app;
}
