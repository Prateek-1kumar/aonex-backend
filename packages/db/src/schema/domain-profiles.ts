import {
  pgTable,
  varchar,
  jsonb,
  numeric,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

export const domainProfiles = pgTable("domain_profiles", {
  domainPattern: varchar("domain_pattern", { length: 200 }).primaryKey(),
  preferredParsers: jsonb("preferred_parsers").$type<string[]>(),
  llmHitRate: numeric("llm_hit_rate", { precision: 5, scale: 4 }),
  avgConfidence: numeric("avg_confidence", { precision: 5, scale: 4 }),
  sampleCount: integer("sample_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DomainProfile = typeof domainProfiles.$inferSelect;
export type NewDomainProfile = typeof domainProfiles.$inferInsert;
