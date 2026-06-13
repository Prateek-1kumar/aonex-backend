// staged_products: hard-block holding area for ingests that fail the catalog
// readiness gate. tenant_id/merchant_id are FK-free by design (transient
// operational data with no catalog_products parent).

import { pgTable, uuid, text, jsonb, numeric, timestamp } from "drizzle-orm/pg-core";

export const stagedProducts = pgTable("staged_products", {
  stagedProductId:  uuid("staged_product_id").primaryKey().defaultRandom(),
  tenantId:         uuid("tenant_id").notNull(),
  merchantId:       uuid("merchant_id").notNull(),
  proposedIdentity: jsonb("proposed_identity").notNull().default({}),
  observations:     jsonb("observations").notNull(),
  denormTitle:      text("denorm_title"),
  denormBrand:      text("denorm_brand"),
  denormPrice:      numeric("denorm_price"),
  denormCurrency:   text("denorm_currency"),
  categoryNodeId:   text("category_node_id"),
  sourceKind:       text("source_kind").notNull(),
  sourceArtifactId: uuid("source_artifact_id"),
  channelCode:      text("channel_code"),
  gateVerdict:      jsonb("gate_verdict").notNull(),
  matchCandidates:  jsonb("match_candidates").notNull().default([]),
  humanFills:       jsonb("human_fills").notNull().default({}),
  status:           text("status").notNull().default("pending"),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedBy:       uuid("resolved_by"),
  resolvedAt:       timestamp("resolved_at", { withTimezone: true })
});

export type StagedProduct = typeof stagedProducts.$inferSelect;
export type NewStagedProduct = typeof stagedProducts.$inferInsert;
