// product_strong_identifiers: projection of every strong identifier currently
// claimed by a catalog row. The PK enforces "at most one product per strong
// (tenant, type, value)", preventing concurrent creates from producing duplicates.

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
