// Spec §11.2 — additive JSON Schema overlay composed via allOf at validator time.
// Tenants may strengthen required and narrow enums; cannot weaken core requirements.

import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

export const tenantCategoryOverlays = pgTable(
  "tenant_category_overlays",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    categoryPath: varchar("category_path", { length: 300 }).notNull(),
    schemaVersion: varchar("schema_version", { length: 50 }).notNull(),
    overlayJson: jsonb("overlay_json").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: uniqueIndex("uq_tenant_category_overlays").on(t.tenantId, t.categoryPath, t.schemaVersion)
  })
);

export type TenantCategoryOverlay = typeof tenantCategoryOverlays.$inferSelect;
export type NewTenantCategoryOverlay = typeof tenantCategoryOverlays.$inferInsert;
