// BullMQ queue + job names — single source of truth.
// Importing this constant is the only sanctioned way to reference
// a queue name. (LLD §3, engineering principles "no string drift".)

export const QUEUE = {
  /** Connection lifecycle on Nango auth webhooks */
  NANGO_AUTH: "nango.auth",
  /** Sync orchestration on Nango sync webhooks */
  NANGO_SYNC: "nango.sync",
  /** Drain pages from Nango cache → source_artifacts */
  NANGO_DRAIN: "nango.drain",
  /** Manual or scheduled sync triggers */
  NANGO_TRIGGER: "nango.trigger",
  /** Hourly sweeper: refresh_failing ≥24h → revoked */
  CONNECTION_SWEEPER: "connection.sweeper",
  /** Phase 2 — extraction hook off staged artifacts */
  INGESTION_EXTRACT: "ingestion.extract",
  /** Phase 3 — parse uploaded CSV file into row-level source_artifacts */
  CSV_PARSE: "csv.parse",
  /** Audit emitter fallback queue (HLD §23: must not drop) */
  AUDIT_FALLBACK: "audit.fallback"
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const JOB_KIND = {
  AUTH: "auth",
  SYNC: "sync",
  INITIAL_SYNC: "initial-sync",
  MANUAL_SYNC: "manual-sync",
  DRAIN: "drain",
  SWEEP_REFRESH_FAILING: "sweep-refresh-failing",
  EXTRACT: "extract",
  CSV_PARSE: "csv-parse"
} as const;

export type JobKind = (typeof JOB_KIND)[keyof typeof JOB_KIND];
