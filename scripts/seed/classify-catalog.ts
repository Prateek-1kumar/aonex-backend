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
import { buildIndex, classifyWithFallback, deterministicResolver, llmResolver, type ProductSignals } from "@aonex/taxonomy-classifier";
import { validateAttributes, type AttributeSpec } from "@aonex/taxonomy-validator";
import { OpenAIProvider } from "@aonex/ingestion-llm-extractor";

/** winning_values keys that aren't product attributes. */
const NON_ATTR = new Set(["title", "category_path", "_meta", "images", "description", "description_long", "description_short"]);

const apply = process.argv.includes("--apply");
const useLlm = process.argv.includes("--llm");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

const llmKey = process.env.GROQ_API_KEY ?? process.env.OPENAI_API_KEY;
const resolver = useLlm && llmKey
  ? llmResolver(
      new OpenAIProvider({ apiKey: llmKey, baseUrl: process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1" }),
      process.env.GROQ_MODEL_ENRICH ?? "llama-3.3-70b-versatile"
    )
  : deterministicResolver;

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

  // Per-leaf attribute schema (node_attributes joined to attribute_definitions).
  const adByKey = new Map((await db.select().from(schema.attributeDefinitions)).map((a) => [a.canonicalKey, a]));
  const schemaByNode = new Map<string, AttributeSpec[]>();
  for (const na of await db.select().from(schema.nodeAttributes)) {
    const ad = adByKey.get(na.canonicalKey);
    const spec: AttributeSpec = { key: na.canonicalKey, tier: na.tier as AttributeSpec["tier"] };
    if (ad?.enumValues?.length) spec.enumValues = ad.enumValues;
    if (ad?.canonicalUnit) { spec.unit = ad.canonicalUnit; spec.dataType = "number"; if (ad.allowedUnits?.length) spec.allowedUnits = ad.allowedUnits; }
    (schemaByNode.get(na.nodeId) ?? schemaByNode.set(na.nodeId, []).get(na.nodeId)!).push(spec);
  }

  const products = await db.select().from(schema.catalogProducts);
  const out: Record<string, number> = { assign: 0, propose_node: 0, abstain: 0 };
  let wrote = 0, cSum = 0, cN = 0;

  /* eslint-disable no-console */
  console.log(`\n=== classify-catalog (${apply ? "APPLY" : "dry-run"}, resolver=${resolver === deterministicResolver ? "deterministic" : "llm"}) — ${products.length} products ===`);
  for (const p of products) {
    const wv = (p.winningValues ?? {}) as Record<string, unknown>;
    const identity = (p.identity ?? {}) as Record<string, unknown>;
    const title = asText(firstScoped(wv.title));
    const signals: ProductSignals = {
      title,
      brand: identity.brand ? String(identity.brand) : undefined,
      sourceCategory: asText(firstScoped(wv.category_path)),
    };
    const r = await classifyWithFallback(signals, index, resolver);
    out[r.outcome] = (out[r.outcome] ?? 0) + 1;
    // Once on a node, validate/normalize the product's attributes against THAT node's schema.
    let attrNote = "";
    if (r.outcome === "assign" && r.nodeId && schemaByNode.has(r.nodeId)) {
      const pattrs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(wv)) if (!NON_ATTR.has(k)) pattrs[k] = firstScoped(v);
      const vr = validateAttributes({ nodeId: r.nodeId, attributes: schemaByNode.get(r.nodeId)! }, pattrs);
      attrNote = `  ·attrs ${vr.completeness.score}/100${vr.violations ? ` ${vr.violations}✗` : ""}`;
      cSum += vr.completeness.score; cN++;
    }
    const detail = r.outcome === "assign" ? r.nodeId : r.outcome === "propose_node" ? `propose "${r.proposedNode?.suggestedName}" under ${r.proposedNode?.parentId}` : "→ Lab";
    console.log(`  ${title.slice(0, 40).padEnd(41)} ${r.outcome.padEnd(8)} ${detail}${attrNote}`);
    if (apply && r.outcome === "assign" && r.nodeId) {
      await db.update(schema.catalogProducts).set({ categoryNodeId: r.nodeId, categorySource: "auto" }).where(eq(schema.catalogProducts.productId, p.productId));
      wrote++;
    }
  }
  console.log(`\n  assign ${out.assign ?? 0} · propose_node ${out.propose_node ?? 0} · abstain ${out.abstain ?? 0}${apply ? ` · wrote ${wrote}` : ""}`);
  console.log(`  avg attr-completeness vs node schema: ${cN ? (cSum / cN).toFixed(1) : "n/a"}/100  (the "before-enrichment" number P2 raises)\n`);
  /* eslint-enable no-console */
} finally {
  await close();
}
