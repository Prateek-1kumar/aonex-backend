import { Hono } from "hono";
import type { AuditEmitter } from "@aonex/audit";
import type { DrizzleClient } from "@aonex/db";
import { listQueue, queueStats } from "../handlers/anomaly-lab.js";

export interface AnomalyLabRouteDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
}

export function anomalyLabRoutes(deps: AnomalyLabRouteDeps): Hono {
  const app = new Hono();
  app.get("/queue", (c) => listQueue(c, deps));
  app.get("/queue/stats", (c) => queueStats(c, deps));
  return app;
}
