// POST /api/ingestions/link — accept a URL for LLM-based product extraction.
//
// HLD §19: API contracts. This is the link ingestion counterpart
// to POST /v1/ingestions/csv.
// HLD §7: "Enqueue and return immediately. All work must be replayable."

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Queue } from "bullmq";
import type { AuditEmitter } from "@aonex/audit";
import { type QUEUE } from "@aonex/types";
import type { DrizzleClient } from "@aonex/db";
import {
  submitLink,
  submitLinkBatch,
  submitCsv,
  getRecentIngestions,
  getIngestionTrace,
} from "../handlers/ingestions.js";

export interface IngestionsRouteDeps {
  queues: { [QUEUE.LINK_EXTRACT]: Queue; [QUEUE.CSV_PARSE]: Queue };
  audit: AuditEmitter;
  db: DrizzleClient;
}

// Reject oversized uploads at the edge, before c.req.formData() buffers the
// whole body into memory. Reads the same env var as the handler so they agree.
const CSV_MAX_BYTES = Number(process.env.CSV_MAX_BYTES ?? 15 * 1024 * 1024);

export function ingestionsRoutes(deps: IngestionsRouteDeps) {
  const app = new Hono();

  app.post("/link", (c) => submitLink(c, deps));
  app.post("/link/batch", (c) => submitLinkBatch(c, deps));
  app.post(
    "/csv",
    bodyLimit({
      maxSize: CSV_MAX_BYTES,
      onError: (c) =>
        c.json(
          { error: { code: "PAYLOAD_TOO_LARGE", message: `File exceeds ${CSV_MAX_BYTES} bytes` } },
          413,
        ),
    }),
    (c) => submitCsv(c, deps),
  );
  app.get("/recent", (c) => getRecentIngestions(c, deps));
  app.get("/:id/trace", (c) => getIngestionTrace(c, deps));

  return app;
}
