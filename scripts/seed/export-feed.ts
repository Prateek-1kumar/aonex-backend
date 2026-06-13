#!/usr/bin/env bun
/**
 * export-feed.ts — P1.5: project a categorized catalog product to its
 * marketplace-feed fields. node_id -> Google product category (via the
 * taxonomy_node_mappings export rows, walking up to the nearest mapped
 * ancestor) + gender/age_group derived from the product's attributes.
 *
 *   DATABASE_URL=... bun scripts/seed/export-feed.ts
 */
import { schema, createDb } from "@aonex/db";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

function firstScoped(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v ?? null;
  const ch = Object.values(v as Record<string, unknown>)[0];
  if (ch == null || typeof ch !== "object") return ch ?? null;
  return Object.values(ch as Record<string, unknown>)[0] ?? null;
}

/** Map our target_gender / a title hint to Google's feed gender values. */
function toGoogleGender(v: unknown): string | null {
  const s = String(v ?? "").toLowerCase();
  if (/\b(female|women|woman|ladies|girl)/.test(s)) return "female";
  if (/\b(male|men|man|boy)/.test(s)) return "male";
  if (/\bunisex|all genders/.test(s)) return "unisex";
  return null;
}

const { client: db, close } = createDb(databaseUrl);
try {
  const exportMappings = (await db.select().from(schema.taxonomyNodeMappings)).filter((m) => m.system === "google" && m.role === "export");
  const googleByNode = new Map(exportMappings.map((m) => [m.nodeId, { id: m.externalId, path: m.externalPath }]));
  const nodes = await db.select().from(schema.taxonomyNodes);
  const parentOf = new Map(nodes.map((n) => [n.nodeId, n.parentId]));
  /** Walk up to the nearest ancestor with a Google export mapping. */
  function googleFor(nodeId: string): { id: string | null; path: string | null } | null {
    let n: string | null = nodeId;
    while (n) {
      const g = googleByNode.get(n);
      if (g) return g;
      n = parentOf.get(n) ?? null;
    }
    return null;
  }

  const products = await db.select().from(schema.catalogProducts);
  /* eslint-disable no-console */
  console.log("\n=== feed export (node -> google_product_category + gender) ===");
  let mapped = 0, unmapped = 0;
  for (const p of products) {
    if (!p.categoryNodeId) continue;
    const wv = (p.winningValues ?? {}) as Record<string, unknown>;
    const title = String(firstScoped(wv.title) ?? "").slice(0, 34);
    const g = googleFor(p.categoryNodeId);
    const gender = toGoogleGender(firstScoped(wv.target_gender)) ?? toGoogleGender(title);
    if (g?.id) mapped++; else unmapped++;
    const pathStr = g?.path ?? (g?.id ? "(Google id only — manual leaf)" : "(unmapped)");
    console.log(`  ${title.padEnd(35)} g_cat=${(g?.id ?? "—").padEnd(5)} ${pathStr}${gender ? `  gender=${gender}` : ""}`);
  }
  console.log(`\n  google_product_category mapped: ${mapped} · unmapped: ${unmapped}\n`);
  /* eslint-enable no-console */
} finally {
  await close();
}
