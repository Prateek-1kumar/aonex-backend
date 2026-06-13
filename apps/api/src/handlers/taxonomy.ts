// Catalog taxonomy read surface — the category tree the marketplace UI
// browses. Returns every ACTIVE node with its hierarchy fields plus this
// workspace's DIRECT product count per node (clients roll counts up to
// ancestors from parentId; node ids are hierarchical slugs).

import type { Context } from "hono";
import { and, count, eq, isNull, ne } from "drizzle-orm";
import { schema } from "@aonex/db";
import { MerchantId, TenantId } from "@aonex/types";
import type { CatalogRouteDeps } from "../routes/catalog.js";

export interface TaxonomyTreeNode {
  nodeId: string;
  parentId: string | null;
  level: number;
  displayName: string;
  displayPath: string;
  isLeaf: boolean;
  /** Products assigned DIRECTLY to this node (not rolled up). */
  productCount: number;
}

export async function getTaxonomyTree(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);

  const listable = [
    eq(schema.catalogProducts.tenantId, tenantId),
    eq(schema.catalogProducts.merchantId, merchantId),
    ne(schema.catalogProducts.status, "merged_into"),
    ne(schema.catalogProducts.status, "deleted"),
  ];

  const [nodes, counts, uncategorizedRow] = await Promise.all([
    deps.db
      .select({
        nodeId: schema.taxonomyNodes.nodeId,
        parentId: schema.taxonomyNodes.parentId,
        level: schema.taxonomyNodes.level,
        displayName: schema.taxonomyNodes.displayName,
        displayPath: schema.taxonomyNodes.displayPath,
        isLeaf: schema.taxonomyNodes.isLeaf,
      })
      .from(schema.taxonomyNodes)
      .where(eq(schema.taxonomyNodes.status, "active"))
      .orderBy(schema.taxonomyNodes.displayPath),
    deps.db
      .select({ nodeId: schema.catalogProducts.categoryNodeId, n: count() })
      .from(schema.catalogProducts)
      .where(and(...listable))
      .groupBy(schema.catalogProducts.categoryNodeId),
    deps.db
      .select({ n: count() })
      .from(schema.catalogProducts)
      .where(and(...listable, isNull(schema.catalogProducts.categoryNodeId))),
  ]);

  const countByNode = new Map(counts.filter((r) => r.nodeId != null).map((r) => [r.nodeId!, Number(r.n)]));
  const tree: TaxonomyTreeNode[] = nodes.map((n) => ({
    nodeId: n.nodeId,
    parentId: n.parentId,
    level: n.level,
    displayName: n.displayName,
    displayPath: n.displayPath,
    isLeaf: n.isLeaf,
    productCount: countByNode.get(n.nodeId) ?? 0,
  }));

  return c.json({
    data: {
      nodes: tree,
      uncategorizedCount: Number(uncategorizedRow[0]?.n ?? 0),
    },
  });
}
