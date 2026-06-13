// Taxonomy spine: the canonical product taxonomy tree (taxonomy_nodes) plus
// aliases (messy label -> node), external-system crosswalk (taxonomy_node_mappings,
// generic over every marketplace), and per-leaf attribute schema (node_attributes).
// Slug-path node ids; gender/age are attributes, not nodes.

import {
  pgTable,
  text,
  uuid,
  integer,
  boolean,
  numeric,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/** The canonical tree. One row per node; leaves carry attribute schemas. */
export const taxonomyNodes = pgTable(
  "taxonomy_nodes",
  {
    /** Stable slug path, e.g. "fashion/clothing/bottoms/jeans". */
    nodeId: text("node_id").primaryKey(),
    parentId: text("parent_id").references((): AnyPgColumn => taxonomyNodes.nodeId),
    /** 0 = department … 3–4 = leaf. */
    level: integer("level").notNull(),
    displayName: text("display_name").notNull(),
    /** Derived breadcrumb, e.g. "Fashion › Clothing › Bottoms › Jeans". */
    displayPath: text("display_path").notNull(),
    isLeaf: boolean("is_leaf").notNull().default(false),
    /** active | draft (proposed by the promotion loop) | deprecated */
    status: text("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    parentIdx: index("idx_taxonomy_nodes_parent").on(t.parentId),
    statusIdx: index("idx_taxonomy_nodes_status").on(t.status),
    pathUnique: uniqueIndex("uq_taxonomy_nodes_display_path").on(t.displayPath),
  })
);

/** Messy label -> node. The deterministic normalization layer + learning loop. */
export const taxonomyAliases = pgTable(
  "taxonomy_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Lowercased, depluralized, punctuation-stripped. */
    normalizedLabel: text("normalized_label").notNull(),
    /** Source vocabulary scope: e.g. "amazon", "csv", or "*" (any). */
    sourceContext: text("source_context").notNull().default("*"),
    nodeId: text("node_id")
      .notNull()
      .references(() => taxonomyNodes.nodeId, { onDelete: "cascade" }),
    /** seed | human (Lab confirmation) | learned */
    origin: text("origin").notNull().default("seed"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("1.000"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    labelUnique: uniqueIndex("uq_taxonomy_aliases_label_ctx").on(t.normalizedLabel, t.sourceContext),
    nodeIdx: index("idx_taxonomy_aliases_node").on(t.nodeId),
  })
);

/** node <-> external taxonomy crosswalk. Generic over every system. */
export const taxonomyNodeMappings = pgTable(
  "taxonomy_node_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: text("node_id")
      .notNull()
      .references(() => taxonomyNodes.nodeId, { onDelete: "cascade" }),
    /** google | shopify | amazon | flipkart | ebay | walmart | … */
    system: text("system").notNull(),
    externalId: text("external_id"),
    externalPath: text("external_path"),
    /** export | import | schema_source | reference */
    role: text("role").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("1.000"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    mapUnique: uniqueIndex("uq_taxonomy_node_mappings").on(t.nodeId, t.system, t.role),
    extIdx: index("idx_taxonomy_node_mappings_ext").on(t.system, t.externalId),
  })
);

/** Per-leaf attribute schema: which canonical attributes apply, at what tier.
 *  `canonicalKey` references attribute_definitions.canonical_key (enforced by the
 *  seed loader + validator, not a DB FK — that column has a unique index, not a
 *  unique constraint). */
export const nodeAttributes = pgTable(
  "node_attributes",
  {
    nodeId: text("node_id")
      .notNull()
      .references(() => taxonomyNodes.nodeId, { onDelete: "cascade" }),
    canonicalKey: text("canonical_key").notNull(),
    /** required | recommended | optional */
    tier: text("tier").notNull(),
    isVariantAxis: boolean("is_variant_axis").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.nodeId, t.canonicalKey] }),
    keyIdx: index("idx_node_attributes_key").on(t.canonicalKey),
  })
);

export type TaxonomyNode = typeof taxonomyNodes.$inferSelect;
export type NewTaxonomyNode = typeof taxonomyNodes.$inferInsert;
export type TaxonomyAlias = typeof taxonomyAliases.$inferSelect;
export type TaxonomyNodeMapping = typeof taxonomyNodeMappings.$inferSelect;
export type NodeAttribute = typeof nodeAttributes.$inferSelect;
export type NewNodeAttribute = typeof nodeAttributes.$inferInsert;
