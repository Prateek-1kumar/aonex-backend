// Pino-based structured logger middleware. Child logger per
// request carries request_id + merchant_id + trace_id (when set).
// LLD §16: PII redaction handled by pino's redact config in the
// composition root.

import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";

export function loggerMiddleware(rootLogger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const requestId = c.get("requestId") as string | undefined;
    const child = rootLogger.child({ requestId, path: c.req.path, method: c.req.method });
    c.set("logger", child);
    const start = Date.now();
    try {
      await next();
      child.info({ status: c.res.status, durationMs: Date.now() - start }, "request.completed");
    } catch (err) {
      child.error({ err, durationMs: Date.now() - start }, "request.failed");
      throw err;
    }
  };
}
