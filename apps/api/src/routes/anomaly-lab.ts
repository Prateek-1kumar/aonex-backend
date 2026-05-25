import { Hono } from "hono";
import type { AuditEmitter } from "@aonex/audit";
import type { DrizzleClient } from "@aonex/db";
import { listQueue, queueStats, getStaged, getEvidence, approveStaged, rejectStaged, linkStaged } from "../handlers/anomaly-lab.js";

export interface AnomalyLabRouteDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
}

export function anomalyLabRoutes(deps: AnomalyLabRouteDeps): Hono {
  const app = new Hono();
  app.get("/queue", (c) => listQueue(c, deps));
  app.get("/queue/stats", (c) => queueStats(c, deps));
  app.get("/staged/:id", (c) => getStaged(c, deps));
  app.get("/staged/:id/evidence", (c) => getEvidence(c, deps));
  app.post("/staged/:id/approve", (c) => approveStaged(c, deps));
  app.post("/staged/:id/reject", (c) => rejectStaged(c, deps));
  app.post("/staged/:id/link", (c) => linkStaged(c, deps));
  return app;
}
