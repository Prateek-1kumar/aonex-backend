#!/usr/bin/env bun
/**
 * classify-catalog.ts — P1.3: run the taxonomy classifier over catalog_products
 * and assign category_node_id. This is the enrichment-stage classification made
 * live against the real catalog (a backfill; the inline worker hook is P1.3b).
 *
 * Signals are built from the reconciled winning_values (title, category_path) +
 * identity (brand). Alias hits auto-assign; everything else goes to the
 * resolver. Dry-run by default — only writes with --apply.
 *
 *   DATABASE_URL=... bun scripts/seed/classify-catalog.ts            # dry-run
 *   DATABASE_URL=... bun scripts/seed/classify-catalog.ts --apply    # write node ids
 */
import { eq } from "drizzle-orm";
import { schema, createDb } from "@aonex/db";
import { buildIndex, classifyWithFallback, deterministicResolver, type ProductSignals } from "@aonex/taxonomy-classifier";

const apply = process.argv.includes("--apply");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

/** winning_values are channel/locale-scoped: {channel: {locale: value}}. Take the first. */
function firstScoped(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v ?? null;
  const ch = Object.values(v as Record<string, unknown>)[0];
  if (ch == null || typeof ch !== "object") return ch ?? null;
  return Object.values(ch as Record<string, unknown>)[0] ?? null;
}
const asText = (v: unknown): string => (Array.isArray(v) ? v.join(" > ") : v == null ? "" : String(v));

const { client: db, close } = createDb(databaseUrl);
try {
  // Build the classifier index from the seeded taxonomy.
  const nodes = await db.select().from(schema.taxonomyNodes);
  const aliasMap = new Map((await db.select().from(schema.taxonomyAliases)).map((a) => [a.normalizedLabel, a.nodeId]));
  const leaves = nodes.filter((n) => n.isLeaf).map((n) => ({ nodeId: n.nodeId, displayName: n.displayName }));
  const departments = nodes.filter((n) => n.level === 0).map((n) => ({ id: n.nodeId, name: n.displayName }));
  const index = buildIndex(leaves, aliasMap, departments);

  const products = await db.select().from(schema.catalogProducts);
  const out: Record<string, number> = { assign: 0, propose_node: 0, abstain: 0 };
  let wrote = 0;

  /* eslint-disable no-console */
  console.log(`\n=== classify-catalog (${apply ? "APPLY" : "dry-run"}) — ${products.length} products ===`);
  for (const p of products) {
    const wv = (p.winningValues ?? {}) as Record<string, unknown>;
    const identity = (p.identity ?? {}) as Record<string, unknown>;
    const title = asText(firstScoped(wv.title));
    const signals: ProductSignals = {
      title,
      brand: identity.brand ? String(identity.brand) : undefined,
      sourceCategory: asText(firstScoped(wv.category_path)),
    };
    const r = await classifyWithFallback(signals, index, deterministicResolver);
    out[r.outcome] = (out[r.outcome] ?? 0) + 1;
    const detail = r.outcome === "assign" ? r.nodeId : r.outcome === "propose_node" ? `propose "${r.proposedNode?.suggestedName}" under ${r.proposedNode?.parentId}` : "→ Lab";
    console.log(`  ${title.slice(0, 42).padEnd(43)} ${r.outcome.padEnd(13)} ${detail}`);
    if (apply && r.outcome === "assign" && r.nodeId) {
      await db.update(schema.catalogProducts).set({ categoryNodeId: r.nodeId }).where(eq(schema.catalogProducts.productId, p.productId));
      wrote++;
    }
  }
  console.log(`\n  assign ${out.assign ?? 0} · propose_node ${out.propose_node ?? 0} · abstain ${out.abstain ?? 0}${apply ? ` · wrote ${wrote}` : ""}\n`);
  /* eslint-enable no-console */
} finally {
  await close();
}
