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
export * from "./extraction.js";
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

// Catalog redesign Phase 1 — append-only revision log
export * from "./catalog-product-revisions.js";

// Catalog redesign Phase 1 — pricing side tables
export * from "./catalog-pricing.js";

// Catalog redesign Phase 1 — inventory side tables
export * from "./catalog-inventory.js";
