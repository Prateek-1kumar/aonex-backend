// marketplace_connections: per-merchant marketplace auth. Provider defaults to
// 'nango' but is stored explicitly so a future direct adapter can coexist.

import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { merchants } from "./merchants.js";
import { marketplaceEnum, connectionStatusEnum } from "./enums.js";

export const marketplaceConnections = pgTable(
  "marketplace_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    marketplace: marketplaceEnum("marketplace").notNull(),
    /** Currently always 'nango'. */
    provider: varchar("provider", { length: 32 }).notNull().default("nango"),
    /** Nango's connectionId — branded ConnectionId in TS. */
    providerConnectionId: varchar("provider_connection_id", { length: 200 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    status: connectionStatusEnum("status").notNull().default("pending"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastTokenRefreshAt: timestamp("last_token_refresh_at", { withTimezone: true }),
    lastRefreshAttempt: timestamp("last_refresh_attempt", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** AES-256-GCM encrypted Shopify access token. Null until auth webhook fires. */
    encryptedAccessToken: text("encrypted_access_token"),
    /** e.g. my-store.myshopify.com — populated from Nango connection_config on auth webhook. */
    shopDomain: varchar("shop_domain", { length: 200 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    merchantMarketplaceUnique: uniqueIndex("uq_merchant_marketplace").on(
      t.merchantId,
      t.marketplace
    ),
    tenantIdx: index("idx_connections_tenant").on(t.tenantId),
    statusIdx: index("idx_connections_status").on(t.status)
  })
);

export type MarketplaceConnection = typeof marketplaceConnections.$inferSelect;
export type NewMarketplaceConnection = typeof marketplaceConnections.$inferInsert;
