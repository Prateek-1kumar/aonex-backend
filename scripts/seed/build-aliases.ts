#!/usr/bin/env bun
/**
 * build-aliases.ts — seed taxonomy_aliases (P0 Task 6).
 *
 * For every node, generates normalized aliases from its display name + variants
 * (no-separator, singular/plural), plus curated synonyms from
 * seed/taxonomy/alias-synonyms.yaml. On a label collision the DEEPER node wins
 * (more specific). Inserted with origin='seed'; the Lab learning loop adds
 * origin='human'/'learned' rows later.
 *
 *   DATABASE_URL=... bun scripts/seed/build-aliases.ts
 *   bun scripts/seed/build-aliases.ts --dry-run
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { schema, createDb } from "@aonex/db";

const LEAVES_DIR = "seed/taxonomy/leaves";
const SYN_FILE = "seed/taxonomy/alias-synonyms.yaml";
const dryRun = process.argv.includes("--dry-run");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

interface Node { node_id: string; name: string }
interface Leaf { node_id: string; name: string }
interface Cat { name: string; node_id: string; children?: Cat[]; leaves?: Leaf[] }
interface Dept { department: string; node_id: string; categories: Cat[] }

const norm = (s: string) =>
  s.toLowerCase().replace(/&/g, " and ").replace(/'/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

function variants(name: string): string[] {
  const b = norm(name);
  const set = new Set<string>([b, b.replace(/ /g, "")]);
  if (b.endsWith("s")) {
    const sing = b.replace(/s$/, "");
    set.add(sing);
    set.add(sing.replace(/ /g, ""));
  }
  return [...set].filter((x) => x.length >= 2);
}

const levelOf = (id: string) => id.split("/").length - 1;
const nodes: Node[] = [];
function walk(cat: Cat) {
  nodes.push({ node_id: cat.node_id, name: cat.name });
  for (const c of cat.children ?? []) walk(c);
  for (const lf of cat.leaves ?? []) nodes.push({ node_id: lf.node_id, name: lf.name });
}
for (const f of readdirSync(LEAVES_DIR).filter((x) => x.endsWith(".yaml"))) {
  const d = yaml.load(readFileSync(join(LEAVES_DIR, f), "utf8")) as Dept;
  nodes.push({ node_id: d.node_id, name: d.department });
  for (const c of d.categories) walk(c);
}

// label -> deepest node
const byLabel = new Map<string, { nodeId: string; level: number }>();
function put(label: string, nodeId: string, level: number) {
  if (!label) return;
  const cur = byLabel.get(label);
  if (!cur || level > cur.level) byLabel.set(label, { nodeId, level });
}
for (const n of nodes) for (const v of variants(n.name)) put(v, n.node_id, levelOf(n.node_id));

// curated synonyms (force to their node)
if (existsSync(SYN_FILE)) {
  const syn = (yaml.load(readFileSync(SYN_FILE, "utf8")) as { synonyms?: Record<string, string[]> })?.synonyms ?? {};
  for (const [nodeId, list] of Object.entries(syn))
    for (const s of list) put(norm(s), nodeId, levelOf(nodeId) + 1); // +1 so curated wins ties
}

const rows = [...byLabel.entries()].map(([normalizedLabel, v]) => ({
  normalizedLabel, sourceContext: "*", nodeId: v.nodeId, origin: "seed",
}));

if (dryRun) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ dryRun: true, aliases: rows.length, sampleTshirt: byLabel.get("tshirt") ?? byLabel.get("t shirt") }, null, 2));
  process.exit(0);
}

const { client: db, close } = createDb(databaseUrl);
const chunk = <T,>(a: T[], n = 500): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
try {
  for (const c of chunk(rows)) await db.insert(schema.taxonomyAliases).values(c).onConflictDoNothing();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ inserted: rows.length }, null, 2));
} finally {
  await close();
}
