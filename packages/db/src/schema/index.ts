// Single export point — drizzle-kit and the client both read this.

export * from "./enums.js";
export * from "./tenants.js";
export * from "./merchants.js";
export * from "./auth.js";
export * from "./connections.js";
export * from "./ingestion.js";
export * from "./audit.js";
export * from "./policy.js";
export * from "./gdpr.js";

// Phase 2 schema
export * from "./category.js";
export * from "./attributes.js";
export * from "./link-ingestion-trace.js";
export * from "./proposed-diffs.js";
export * from "./products.js";
export * from "./review.js";
export * from "./extraction-failures.js";
export * from "./price-clusters.js";
export * from "./domain-profiles.js";

// Phase 1 canonical-schema additions
export * from "./category-labels.js";
export * from "./tenant-category-overlays.js";
export * from "./category-attribute-promotion-candidates.js";

// Catalog redesign Phase 1 — registry tables
export * from "./channels.js";

// Catalog redesign Phase 1 — core product table
export * from "./catalog-products.js";

// Catalog redesign Phase 2 — identity spine concurrency guard
export * from "./product-strong-identifiers.js";

// Catalog redesign Phase 1 — append-only revision log
export * from "./catalog-product-revisions.js";

// Catalog redesign Phase 1 — pricing side tables
export * from "./catalog-pricing.js";

// Catalog redesign Phase 1 — inventory side tables
export * from "./catalog-inventory.js";

// Catalog redesign Phase 1 — effective-dated source priority rules
export * from "./source-priority.js";

// Catalog redesign Phase 1 — append-only identity-field audit log
export * from "./identity-log.js";

// Catalog redesign Phase 1 — manual per-product winning-value pins
export * from "./reconciliation-overrides.js";

// Catalog redesign Phase 1 — merge/split/unmerge lineage history
export * from "./product-lineage.js";

// Catalog redesign Phase 1 — partitioned outbox + DLQ
export * from "./catalog-events.js";

// Catalog redesign Phase 5 — per-tenant webhook subscriptions
export * from "./tenant-webhooks.js";

// Catalog redesign Phase 7 — resumable backfill cursor
export * from "./backfill-cursor.js";

// Anomaly Lab — staging gate
export * from "./staged-products.js";

export * from "./catalog-reviews.js";

// Catalog enrichment Phase 0 — DB-backed archetype attribute schemas (self-extending)
export * from "./archetype-attribute-specs.js";

// Catalog enrichment Phase 1 — review-then-apply proposals
export * from "./enrichment-proposals.js";
