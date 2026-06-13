// BullMQ queue + job names: the single source of truth. Importing these
// constants is the only sanctioned way to reference a queue/job name, so names
// can't drift between producers and consumers.

export const QUEUE = {
  /** Connection lifecycle on Nango auth webhooks. */
  NANGO_AUTH: "nango.auth",
  /** Sync orchestration on Nango sync webhooks. */
  NANGO_SYNC: "nango.sync",
  /** Drain pages from Nango cache into source_artifacts. */
  NANGO_DRAIN: "nango.drain",
  /** Manual or scheduled sync triggers. */
  NANGO_TRIGGER: "nango.trigger",
  /** Hourly sweeper: refresh_failing for >=24h becomes revoked. */
  CONNECTION_SWEEPER: "connection.sweeper",
  /** Extraction hook off staged artifacts. */
  INGESTION_EXTRACT: "ingestion.extract",
  /** Parse an uploaded CSV file into row-level source_artifacts. */
  CSV_PARSE: "csv.parse",
  /** Link/URL ingestion: fetch HTML, run LLM extraction, produce extracted facts. */
  LINK_EXTRACT: "ingestion.link_extract",
  /** Audit emitter fallback queue (must not drop). */
  AUDIT_FALLBACK: "audit.fallback",
  /** Catalog enrichment "Push to Enrich" LLM job (slow; low concurrency). */
  PRODUCT_ENRICH: "catalog.product_enrich"
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
  CSV_PARSE: "csv-parse",
  LINK_EXTRACT: "link-extract",
  PRODUCT_ENRICH: "product-enrich"
} as const;

export type JobKind = (typeof JOB_KIND)[keyof typeof JOB_KIND];
