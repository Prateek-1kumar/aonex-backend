// Map raw Nango / HTTP errors → GatewayError discriminated union.
// HLD §17.3: structured errors per kind. Rule: every adapter
// throws GatewayError, never the raw vendor error. Stack traces
// preserved via `cause`.

import { GatewayError, type GatewayErrorKind } from "@aonex/types";

interface MaybeStatus {
  status?: number;
  statusCode?: number;
  response?: { status?: number };
  code?: string;
  message?: string;
  retryAfter?: number;
}

export function mapNangoError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  const e = (typeof err === "object" && err !== null ? err : {}) as MaybeStatus;
  const status = e.status ?? e.statusCode ?? e.response?.status;
  const message = e.message ?? "Unknown gateway error";

  let kind: GatewayErrorKind = "internal";
  if (status === 401 || e.code === "AUTH_FAILED") kind = "auth_failed";
  else if (status === 404) kind = "connection_not_found";
  else if (status === 409) kind = "connection_revoked";
  else if (status === 422) kind = "validation_failed";
  else if (status === 429) kind = "rate_limited";
  else if (status && status >= 500 && status < 600) kind = "provider_5xx";
  else if (status && status >= 400 && status < 500) kind = "provider_4xx";
  else if (e.code === "ETIMEDOUT" || /timeout/i.test(message)) kind = "timeout";

  return new GatewayError(kind, message, {
    cause: err,
    ...(typeof status === "number" ? { providerStatus: status } : {}),
    ...(typeof e.retryAfter === "number" ? { retryAfterMs: e.retryAfter * 1000 } : {})
  });
}
