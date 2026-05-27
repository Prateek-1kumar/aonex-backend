// POST /api/ingestions/link — accept a URL for LLM-based product extraction.
//
// HLD §19: API contracts. This is the link ingestion counterpart
// to POST /v1/ingestions/csv.
// HLD §7: "Enqueue and return immediately. All work must be replayable."

import { Hono } from "hono";
import type { Queue } from "bullmq";
import type { AuditEmitter } from "@aonex/audit";
import { type QUEUE } from "@aonex/types";
import type { DrizzleClient } from "@aonex/db";
import {
  submitLink,
  submitLinkBatch,
  getRecentIngestions,
  getIngestionTrace,
} from "../handlers/ingestions.js";

export interface IngestionsRouteDeps {
  queues: { [QUEUE.LINK_EXTRACT]: Queue };
  audit: AuditEmitter;
  db: DrizzleClient;
}

export function ingestionsRoutes(deps: IngestionsRouteDeps) {
  const app = new Hono();

  app.post("/link", (c) => submitLink(c, deps));
  app.post("/link/batch", (c) => submitLinkBatch(c, deps));
  app.get("/recent", (c) => getRecentIngestions(c, deps));
  app.get("/:id/trace", (c) => getIngestionTrace(c, deps));

  return app;
}
