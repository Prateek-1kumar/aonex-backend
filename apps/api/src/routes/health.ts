// /healthz (liveness) and /readyz (readiness — checks Pg + Redis).

import { Hono } from "hono";
import type { Pool } from "@aonex/db";
import type IORedis from "ioredis";

export interface HealthDeps {
  pool: Pool;
  redis: IORedis;
}

export function healthRoutes(deps: HealthDeps): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    try {
      await deps.pool.query("SELECT 1");
      const pong = await deps.redis.ping();
      return c.json({ ok: pong === "PONG" });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 503);
    }
  });
  return app;
}
