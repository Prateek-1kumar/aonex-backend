// Phase 2: identity spine concurrency guard.
// product_strong_identifiers: a projection of every STRONG identifier currently
// claimed by a catalog row, so the DB's UNIQUE constraint enforces "at most one
// product per strong (tenant, type, value)" — preventing simultaneous creates
// from producing duplicates. Spec C1/D2; plan Phase 2 Task 1.

import { pgTable, uuid, text, primaryKey } from "drizzle-orm/pg-core";
import { catalogProducts } from "./catalog-products.js";

export const productStrongIdentifiers = pgTable(
  "product_strong_identifiers",
  {
    tenantId:        uuid("tenant_id").notNull(),
    identifierType:  text("identifier_type").notNull(),
    identifierValue: text("identifier_value").notNull(),
    productId:       uuid("product_id")
      .notNull()
      .references(() => catalogProducts.productId, { onDelete: "cascade" })
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.identifierType, t.identifierValue] })
  })
);

export type ProductStrongIdentifier = typeof productStrongIdentifiers.$inferSelect;
export type NewProductStrongIdentifier = typeof productStrongIdentifiers.$inferInsert;
