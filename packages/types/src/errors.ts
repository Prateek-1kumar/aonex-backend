// GatewayError — the discriminated union every adapter throws.
// HLD §17.3 lists the kinds; we normalize to these regardless of
// upstream provider (Nango, direct, Apideck).
//
// LLD §7.1 ties each kind to a retry policy + operator action.

export const GATEWAY_ERROR_KINDS = [
  "invalid_signature",
  "invalid_payload",
  "connection_not_found",
  "connection_revoked",
  "auth_failed",
  "rate_limited",
  "validation_failed",
  "provider_4xx",
  "provider_5xx",
  "timeout",
  "nango_unavailable",
  "nango_quota_exceeded",
  "internal"
] as const;

export type GatewayErrorKind = (typeof GATEWAY_ERROR_KINDS)[number];

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly cause?: unknown;
  readonly retryAfterMs?: number;
  readonly providerStatus?: number;

  constructor(
    kind: GatewayErrorKind,
    message: string,
    opts: { cause?: unknown; retryAfterMs?: number; providerStatus?: number } = {}
  ) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.providerStatus !== undefined) this.providerStatus = opts.providerStatus;
  }
}

/**
 * Per-kind retry / HTTP-status mapping.
 * Source of truth for both BullMQ retry decisions and HTTP edge.
 */
export const GATEWAY_ERROR_POLICY: Record<
  GatewayErrorKind,
  { retryable: boolean; httpStatus: number }
> = {
  invalid_signature: { retryable: false, httpStatus: 401 },
  invalid_payload: { retryable: false, httpStatus: 400 },
  connection_not_found: { retryable: false, httpStatus: 404 },
  connection_revoked: { retryable: false, httpStatus: 409 },
  auth_failed: { retryable: false, httpStatus: 401 },
  rate_limited: { retryable: true, httpStatus: 429 },
  validation_failed: { retryable: false, httpStatus: 422 },
  provider_4xx: { retryable: false, httpStatus: 502 },
  provider_5xx: { retryable: true, httpStatus: 502 },
  timeout: { retryable: true, httpStatus: 504 },
  nango_unavailable: { retryable: true, httpStatus: 503 },
  nango_quota_exceeded: { retryable: true, httpStatus: 503 },
  internal: { retryable: true, httpStatus: 500 }
};

export function isGatewayError(err: unknown): err is GatewayError {
  return err instanceof GatewayError;
}
