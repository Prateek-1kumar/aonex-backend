// Anomaly Lab — taxonomy category handlers (P1.4).
//
// The constrained tree-picker + learning loop:
//   GET  /lab/taxonomy/search?q=     — typeahead over real nodes (no free text)
//   GET  /lab/taxonomy/uncategorized — products with no category, + classifier suggestions
//   POST /lab/products/:id/categorize — confirm a node; on confirm, write the raw
//        source label -> node into taxonomy_aliases (origin=human) so the NEXT
//        same product auto-classifies. That's the learning loop.

import type { Context } from "hono";
import { and, eq, ilike, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@aonex/db";
import { TenantId } from "@aonex/types";
import { buildIndex, classify, normLabel, type ClassifierIndex, type ProductSignals } from "@aonex/taxonomy-classifier";
import type { AnomalyLabRouteDeps } from "../routes/anomaly-lab.js";

function firstScoped(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v ?? null;
  const ch = Object.values(v as Record<string, unknown>)[0];
  if (ch == null || typeof ch !== "object") return ch ?? null;
  return Object.values(ch as Record<string, unknown>)[0] ?? null;
}
const asText = (v: unknown): string => (Array.isArray(v) ? v.join(" > ") : v == null ? "" : String(v));

async function loadIndexAndPaths(db: AnomalyLabRouteDeps["db"]): Promise<{ index: ClassifierIndex; pathById: Map<string, string> }> {
  const nodes = await db.select().from(schema.taxonomyNodes);
  const aliasMap = new Map((await db.select().from(schema.taxonomyAliases)).map((a) => [a.normalizedLabel, a.nodeId]));
  const index = buildIndex(
    nodes.filter((n) => n.isLeaf).map((n) => ({ nodeId: n.nodeId, displayName: n.displayName })),
    aliasMap,
    nodes.filter((n) => n.level === 0).map((n) => ({ id: n.nodeId, name: n.displayName }))
  );
  return { index, pathById: new Map(nodes.map((n) => [n.nodeId, n.displayPath])) };
}

/** Typeahead over real nodes — the picker can only resolve to a node, never free text. */
export async function searchTaxonomy(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ data: { nodes: [] } });
  const rows = await deps.db
    .select({ nodeId: schema.taxonomyNodes.nodeId, displayPath: schema.taxonomyNodes.displayPath, isLeaf: schema.taxonomyNodes.isLeaf })
    .from(schema.taxonomyNodes)
    .where(and(eq(schema.taxonomyNodes.status, "active"), ilike(schema.taxonomyNodes.displayPath, `%${q}%`)))
    .orderBy(schema.taxonomyNodes.displayPath)
    .limit(25);
  return c.json({ data: { nodes: rows } });
}

/** Products with no category yet + the classifier's top suggestions for each. */
export async function listUncategorized(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const products = await deps.db
    .select({ productId: schema.catalogProducts.productId, winningValues: schema.catalogProducts.winningValues, identity: schema.catalogProducts.identity })
    .from(schema.catalogProducts)
    .where(and(eq(schema.catalogProducts.tenantId, tenantId), isNull(schema.catalogProducts.categoryNodeId)))
    .limit(50);

  const { index, pathById } = await loadIndexAndPaths(deps.db);
  const items = products.map((p) => {
    const wv = (p.winningValues ?? {}) as Record<string, unknown>;
    const identity = (p.identity ?? {}) as Record<string, unknown>;
    const title = asText(firstScoped(wv.title));
    const sourceCategory = asText(firstScoped(wv.category_path));
    const signals: ProductSignals = { title, sourceCategory, ...(identity.brand ? { brand: String(identity.brand) } : {}) };
    const r = classify(signals, index);
    const suggestions = (r.nodeId ? [{ nodeId: r.nodeId, score: r.confidence }, ...r.alternatives] : r.alternatives)
      .slice(0, 5)
      .map((c2) => ({ nodeId: c2.nodeId, displayPath: pathById.get(c2.nodeId) ?? c2.nodeId, score: Math.round(c2.score * 100) / 100 }));
    return { productId: p.productId, title, sourceCategory, suggestions };
  });
  return c.json({ data: { items } });
}

const CategorizeSchema = z.object({
  nodeId: z.string().min(1),
  /** Raw source label to learn (defaults to the product's source category). */
  rawLabel: z.string().optional(),
});

/** Confirm a category for a product + (learning loop) teach the alias table. */
export async function categorizeProduct(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const productId = c.req.param("id") as string;
  const parsed = CategorizeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: { code: "VALIDATION_FAILED", message: "nodeId required" } }, 400);
  const { nodeId, rawLabel } = parsed.data;

  // Canonical-path invariant: the node must be a real, active node.
  const node = await deps.db
    .select({ nodeId: schema.taxonomyNodes.nodeId })
    .from(schema.taxonomyNodes)
    .where(and(eq(schema.taxonomyNodes.nodeId, nodeId), eq(schema.taxonomyNodes.status, "active")))
    .limit(1);
  if (!node[0]) return c.json({ error: { code: "BAD_REQUEST", message: "unknown taxonomy node" } }, 400);

  const updated = await deps.db
    .update(schema.catalogProducts)
    .set({ categoryNodeId: nodeId, categorySource: "human" })
    .where(and(eq(schema.catalogProducts.productId, productId), eq(schema.catalogProducts.tenantId, tenantId)))
    .returning({ productId: schema.catalogProducts.productId });
  if (updated.length === 0) return c.json({ error: { code: "NOT_FOUND", message: "Product not found" } }, 404);

  // Learning loop: a human confirmation teaches the alias table so the next
  // product with this source label auto-classifies.
  let learned = false;
  if (rawLabel && rawLabel.trim()) {
    const normalized = normLabel(rawLabel);
    if (normalized) {
      await deps.db
        .insert(schema.taxonomyAliases)
        .values({ normalizedLabel: normalized, sourceContext: "*", nodeId, origin: "human" })
        .onConflictDoNothing();
      learned = true;
    }
  }
  return c.json({ data: { productId, nodeId, learned } });
}
