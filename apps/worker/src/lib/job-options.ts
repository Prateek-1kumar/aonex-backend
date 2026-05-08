// Worker BullMQ defaults — concurrency, lock duration.
// Drain queue gets a longer lock since each page can take seconds.

export const WORKER_DEFAULTS = {
  /** Generic queues: 5 concurrent jobs per worker process. */
  concurrency: 5,
  /** Drain queue: page-iteration can be slow, extend lock. */
  drainLockDurationMs: 10 * 60 * 1000
} as const;

/** Single in-flight initial-sync per (merchant, marketplace) — Redis SETNX. */
export const SINGLE_FLIGHT_TTL_MS = 15 * 60 * 1000;
