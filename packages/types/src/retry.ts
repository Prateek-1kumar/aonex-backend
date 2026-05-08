// Retry math — mirrors Nango's `getExponentialBackoff(attempt, max)
// = min(3000 * 2^attempt, max)` so consumption-side retries align
// with Nango's webhook delivery cadence. (LLD §4 / Q9.)

/** Base delay in ms — Nango's constant. */
export const RETRY_BASE_MS = 3000;
export const RETRY_MAX_MS = 600_000;

/**
 * Exponential backoff with optional max ceiling.
 * Deterministic — used at the BullMQ level. HTTP-level retries
 * add jitter (lib-utils/exponential-backoff.ts).
 */
export function getExponentialBackoff(attempt: number, maxMs = RETRY_MAX_MS): number {
  if (attempt < 0) return RETRY_BASE_MS;
  return Math.min(RETRY_BASE_MS * Math.pow(2, attempt), maxMs);
}

/**
 * Canonical job options applied to every BullMQ producer call.
 * Sequence: 3s → 6s → 12s → 24s → 48s. <90s before DLQ.
 *
 * `removeOnFail: false` — failed jobs ARE the DLQ. (LLD §13.)
 */
export const STANDARD_RETRY = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: RETRY_BASE_MS },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: false
} as const;
