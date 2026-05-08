// Per-request correlation id. Used by logger, tracing, and
// audit emitter so every event carries the same request_id.

import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const id = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", id);
    c.header("x-request-id", id);
    await next();
  };
}
