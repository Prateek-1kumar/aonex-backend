// Edge error handler — converts GatewayError + ZodError into the
// stable response envelope. Routes/services THROW; this layer
// translates. (Engineering principles, "throw at edge".)

import type { ErrorHandler } from "hono";
import { ZodError } from "zod";
import { GATEWAY_ERROR_POLICY, isGatewayError } from "@aonex/types";

export const errorHandler: ErrorHandler = (err, c) => {
  if (isGatewayError(err)) {
    const policy = GATEWAY_ERROR_POLICY[err.kind];
    return c.json(
      {
        error: { code: err.kind.toUpperCase(), message: err.message },
        meta: { requestId: c.get("requestId") }
      },
      policy.httpStatus as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503 | 504
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Request body failed validation",
          details: err.flatten()
        },
        meta: { requestId: c.get("requestId") }
      },
      422
    );
  }
  return c.json(
    {
      error: { code: "INTERNAL", message: "Unexpected server error" },
      meta: { requestId: c.get("requestId") }
    },
    500
  );
};
