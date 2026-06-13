// Retry backoff math, mirroring Nango's min(3000 * 2^attempt, max) so
// consumption-side retries align with Nango's webhook delivery cadence.

/** Base delay in ms, matching Nango's constant. */
export const RETRY_BASE_MS = 3000;
export const RETRY_MAX_MS = 600_000;

/**
 * Deterministic exponential backoff (used at the BullMQ level) with an optional
 * max ceiling. HTTP-level retries add jitter separately.
 */
export function getExponentialBackoff(attempt: number, maxMs = RETRY_MAX_MS): number {
  if (attempt < 0) return RETRY_BASE_MS;
  return Math.min(RETRY_BASE_MS * Math.pow(2, attempt), maxMs);
}

/**
 * Canonical job options for every BullMQ producer call. `removeOnFail: false`
 * is deliberate: failed jobs are retained and serve as the dead-letter queue.
 */
export const STANDARD_RETRY = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: RETRY_BASE_MS },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: false
} as const;
