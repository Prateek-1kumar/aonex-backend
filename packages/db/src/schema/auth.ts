// LLD §4 — JWT session revocation + webhook idempotency.
// Both tables are auxiliary to the HLD; the HLD doesn't specify
// auth token storage, but multi-tenant + revocation requires both.

import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { merchants } from "./merchants.js";

export const merchantSessions = pgTable(
  "merchant_sessions",
  {
    jti: varchar("jti", { length: 64 }).primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (t) => ({
    merchantIdx: index("idx_sessions_merchant").on(t.merchantId),
    expiresIdx: index("idx_sessions_expires").on(t.expiresAt)
  })
);

/**
 * Webhook idempotency. webhook_id = sha256(rawBody).
 * BRIN index on received_at — append-only, ~monotonic, cheap cleanup cron. (LLD P1-9.)
 */
export const processedWebhooks = pgTable(
  "processed_webhooks",
  {
    webhookId: varchar("webhook_id", { length: 200 }).primaryKey(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    receivedAtBrin: index("idx_processed_webhooks_received_at")
      .using("brin", t.receivedAt)
  })
);

export type MerchantSession = typeof merchantSessions.$inferSelect;
export type ProcessedWebhook = typeof processedWebhooks.$inferSelect;
