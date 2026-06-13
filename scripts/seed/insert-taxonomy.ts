#!/usr/bin/env bun
/**
 * insert-taxonomy.ts — load the canonical taxonomy into the DB (P0 Task 8).
 *
 * Reads the generated seed/taxonomy/leaves/<dept>.yaml + attribute-definitions.yaml
 * and inserts:
 *   - taxonomy_nodes          (the tree: departments -> categories -> leaves)
 *   - attribute_definitions   (shared canonical attributes + value sets, extended)
 *   - node_attributes         (per-leaf schema: attribute + tier)
 *   - taxonomy_node_mappings  (shopify schema_source + google export per leaf)
 *
 * Idempotent (ON CONFLICT DO NOTHING). Nodes are inserted level-by-level so a
 * parent always exists before its children (self-FK on parent_id).
 *
 * Usage:
 *   DATABASE_URL=... bun scripts/seed/insert-taxonomy.ts            # load
 *   bun scripts/seed/insert-taxonomy.ts --dry-run                  # counts only
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { schema, createDb } from "@aonex/db";

const LEAVES_DIR = "seed/taxonomy/leaves";
const ATTR_FILE = "seed/taxonomy/attribute-definitions.yaml";
const dryRun = process.argv.includes("--dry-run");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

interface Leaf {
  node_id: string; name: string; manual?: boolean;
  shopify_ref?: string | null; shopify_path?: string;
  google_id?: string | null; google_path?: string;
  attributes?: { key: string; tier: string }[];
}
interface Cat { name: string; node_id: string; children?: Cat[]; leaves?: Leaf[] }
interface Dept { department: string; node_id: string; categories: Cat[] }

const VARIANT_AXES = new Set(["size", "color", "shoe-size"]);
const levelOf = (id: string) => id.split("/").length - 1;

const nodes: { nodeId: string; parentId: string | null; level: number; displayName: string; displayPath: string; isLeaf: boolean }[] = [];
const mappings: { nodeId: string; system: string; externalId: string; externalPath: string | null; role: string; isPrimary: boolean }[] = [];
const nodeAttrs: { nodeId: string; canonicalKey: string; tier: string; isVariantAxis: boolean }[] = [];

function addNode(nodeId: string, parentId: string | null, name: string, path: string, isLeaf: boolean) {
  nodes.push({ nodeId, parentId, level: levelOf(nodeId), displayName: name, displayPath: path, isLeaf });
}
function walkLeaf(lf: Leaf, parentId: string, parentPath: string) {
  const path = `${parentPath} › ${lf.name}`;
  addNode(lf.node_id, parentId, lf.name, path, true);
  if (lf.shopify_ref) mappings.push({ nodeId: lf.node_id, system: "shopify", externalId: lf.shopify_ref, externalPath: lf.shopify_path ?? null, role: "schema_source", isPrimary: true });
  if (lf.google_id) mappings.push({ nodeId: lf.node_id, system: "google", externalId: lf.google_id, externalPath: lf.google_path ?? null, role: "export", isPrimary: true });
  for (const a of lf.attributes ?? []) nodeAttrs.push({ nodeId: lf.node_id, canonicalKey: a.key, tier: a.tier, isVariantAxis: VARIANT_AXES.has(a.key) });
}
function walkCat(cat: Cat, parentId: string, parentPath: string) {
  const path = `${parentPath} › ${cat.name}`;
  addNode(cat.node_id, parentId, cat.name, path, false);
  for (const c of cat.children ?? []) walkCat(c, cat.node_id, path);
  for (const lf of cat.leaves ?? []) walkLeaf(lf, cat.node_id, path);
}

for (const f of readdirSync(LEAVES_DIR).filter((x) => x.endsWith(".yaml"))) {
  const d = yaml.load(readFileSync(join(LEAVES_DIR, f), "utf8")) as Dept;
  addNode(d.node_id, null, d.department, d.department, false);
  for (const c of d.categories) walkCat(c, d.node_id, d.department);
}
nodes.sort((a, b) => a.level - b.level); // parents (lower level) before children

const attrDoc = yaml.load(readFileSync(ATTR_FILE, "utf8")) as { attributes: { handle: string; label: string; values: string[]; provenance?: unknown }[] };
const attrDefs = attrDoc.attributes.map((a) => ({
  canonicalKey: a.handle,
  dataType: "string",
  enumValues: a.values ?? [],
  label: a.label,
  origin: "seed",
  provenance: (a.provenance ?? null) as { sources?: { system: string; ref?: string }[] } | null,
}));

const counts = { nodes: nodes.length, attrDefs: attrDefs.length, nodeAttrs: nodeAttrs.length, mappings: mappings.length };

function chunk<T>(arr: T[], n = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

if (dryRun) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ dryRun: true, ...counts }, null, 2));
  process.exit(0);
}

const { client: db, close } = createDb(databaseUrl);
try {
  for (const c of chunk(attrDefs)) await db.insert(schema.attributeDefinitions).values(c).onConflictDoNothing();
  for (const c of chunk(nodes)) await db.insert(schema.taxonomyNodes).values(c).onConflictDoNothing();
  for (const c of chunk(nodeAttrs)) await db.insert(schema.nodeAttributes).values(c).onConflictDoNothing();
  for (const c of chunk(mappings)) await db.insert(schema.taxonomyNodeMappings).values(c).onConflictDoNothing();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ inserted: counts }, null, 2));
} finally {
  await close();
}
