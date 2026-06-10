#!/usr/bin/env bun
/**
 * build-taxonomy.ts — deterministic taxonomy extractor (P0 Task 4/5 engine).
 *
 * Curation judgment lives in seed/taxonomy/curation/<dept>.yaml (which leaves,
 * mapped to a generic Shopify category gid). This script does the MECHANICAL
 * fill: pulls each leaf's attributes (pruned of context-specific junk), the
 * Shopify->Google export id, value-sets, display paths/levels/slugs, and a
 * first-pass tier — then emits seed/taxonomy/leaves/<dept>.yaml plus a shared
 * seed/taxonomy/attribute-definitions.yaml. A human reviews each department.
 *
 * Reference data (Shopify Standard Product Taxonomy v2026-02, MIT) is cached
 * under seed/taxonomy/refs/.cache (gitignored); fetched on first run.
 *
 * Usage:
 *   bun scripts/seed/build-taxonomy.ts                 # build all curation maps
 *   bun scripts/seed/build-taxonomy.ts --dept fashion  # one department
 *   bun scripts/seed/build-taxonomy.ts --list aa-1-12  # list a Shopify subtree
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(ROOT, "seed/taxonomy/refs/.cache");
const CURATION_DIR = join(ROOT, "seed/taxonomy/curation");
const LEAVES_DIR = join(ROOT, "seed/taxonomy/leaves");
const ATTR_OUT = join(ROOT, "seed/taxonomy/attribute-definitions.yaml");
const MANUAL_FILE = join(ROOT, "seed/taxonomy/manual-schemas.yaml");
const MANUAL_SCHEMAS: Record<string, { key: string; tier: string; values?: string[] }[]> = existsSync(MANUAL_FILE)
  ? ((yaml.load(readFileSync(MANUAL_FILE, "utf8")) as { schemas?: Record<string, { key: string; tier: string; values?: string[] }[]> })?.schemas ?? {})
  : {};
const SHOPIFY_TAG = "v2026-02";
const BASE = `https://raw.githubusercontent.com/Shopify/product-taxonomy/${SHOPIFY_TAG}/dist/en`;

// Context-specific attribute handles we never carry onto a generic node.
const PRUNE_ATTRS = new Set([
  "activity", "activewear-clothing-features", "pronation-support", "best-uses",
]);
// First-pass tiering (refined by a human in Task 5). Presence-based.
const REQUIRED = new Set(["color", "size", "shoe-size", "target-gender", "fabric", "footwear-material", "material"]);
const RECOMMENDED = new Set([
  "age-group", "pattern", "fit", "neckline", "sleeve-length-type", "waist-rise",
  "bag-case-material", "eyewear-frame-material", "closure-type",
]);

interface ShopifyCat { id: string; name: string; full_name: string; level: number; attributes: { handle: string }[]; children: { id: string; name: string }[]; }
interface Refs {
  byId: Map<string, ShopifyCat>;
  byName: Map<string, ShopifyCat[]>; // lowercased leaf name -> candidates
  attrValues: Map<string, { label: string; values: string[] }>;
  googleId: Map<string, { id: string; path: string }>; // shopify shortId -> google
}

// Context buckets we skip when auto-resolving a leaf to its GENERIC node.
const CONTEXT = ["Activewear", "Maternity", "Baby & Children's", "Uniforms & Workwear", "Traditional & Ceremonial", "Plus Size", "Petite", "Tall"];

/** Resolve a leaf NAME to the shallowest non-context Shopify node's gid.
 *  Tiers: exact name -> singular/plural -> substring (either direction). All
 *  matches surface `shopify_path` in the output for human verification. */
function resolveGeneric(refs: Refs, name: string): string | null {
  const q = name.toLowerCase();
  let pool = refs.byName.get(q) ?? [];
  if (!pool.length) {
    for (const v of [q.replace(/s$/, ""), `${q}s`, q.replace(/ies$/, "y"), q.replace(/y$/, "ies")]) {
      const m = refs.byName.get(v);
      if (m?.length) { pool = m; break; }
    }
  }
  if (!pool.length && q.length >= 4) {
    pool = [...refs.byId.values()].filter((c) => {
      const n = c.name.toLowerCase();
      return n.length >= 4 && (n.includes(q) || q.includes(n));
    });
  }
  const generic = pool.filter((c) => !CONTEXT.some((x) => c.full_name.includes(x)));
  const final = (generic.length ? generic : pool).slice().sort((a, b) => a.full_name.split(" > ").length - b.full_name.split(" > ").length);
  return final[0] ? shortId(final[0].id) : null;
}

const shortId = (gid: string) => gid.replace("gid://shopify/TaxonomyCategory/", "");
const slug = (s: string) =>
  s.toLowerCase().replace(/&/g, "and").replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

async function ensure(file: string, url: string): Promise<string> {
  const path = join(CACHE, file);
  if (existsSync(path)) return path;
  mkdirSync(CACHE, { recursive: true });
  process.stderr.write(`fetching ${url} …\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

async function loadRefs(): Promise<Refs> {
  const cats = JSON.parse(readFileSync(await ensure("categories.json", `${BASE}/categories.json`), "utf8"));
  const attrs = JSON.parse(readFileSync(await ensure("attributes.json", `${BASE}/attributes.json`), "utf8"));
  const maps = JSON.parse(readFileSync(await ensure("all_mappings.json", `${BASE}/integrations/all_mappings.json`), "utf8"));

  const byId = new Map<string, ShopifyCat>();
  const byName = new Map<string, ShopifyCat[]>();
  for (const v of cats.verticals)
    for (const c of v.categories) {
      byId.set(shortId(c.id), c);
      const k = c.name.toLowerCase();
      (byName.get(k) ?? byName.set(k, []).get(k)!).push(c);
    }

  const attrValues = new Map<string, { label: string; values: string[] }>();
  const adata = Array.isArray(attrs) ? attrs : attrs.attributes;
  for (const a of adata) {
    const handle = a.handle ?? String(a.name).toLowerCase();
    attrValues.set(handle, { label: a.name, values: (a.values ?? []).map((v: { name?: string }) => (typeof v === "string" ? v : v.name)) });
  }

  const googleId = new Map<string, { id: string; path: string }>();
  const sg = maps.mappings.find((m: { output_taxonomy?: string }) => String(m.output_taxonomy ?? "").includes("google"));
  for (const r of sg?.rules ?? []) {
    const out = r.output?.category?.[0];
    if (r.input?.category?.id && out) googleId.set(shortId(r.input.category.id), { id: out.id, path: out.full_name });
  }
  return { byId, byName, attrValues, googleId };
}

function tierOf(handle: string): "required" | "recommended" | "optional" {
  if (REQUIRED.has(handle)) return "required";
  if (RECOMMENDED.has(handle)) return "recommended";
  return "optional";
}

// First-pass curation: merge near-duplicate handles and cap per-leaf breadth.
const RENAME: Record<string, string> = { "recommended-age-group": "age-group" };
function normHandle(h: string): string {
  if (RENAME[h]) return RENAME[h];
  for (const s of ["-color", "-pattern", "-material"]) if (h.endsWith(s) && h !== s.slice(1)) return s.slice(1);
  return h;
}
const titleCase = (h: string) => h.split("-").map((w) => (w[0] ?? "").toUpperCase() + w.slice(1)).join(" ");
const TIER_RANK: Record<string, number> = { required: 0, recommended: 1, optional: 2 };
const LEAF_ATTR_CAP = 12;

/** Resolve one leaf gid -> emitted leaf object + records its attribute defs. */
function buildLeaf(name: string, gidOrAuto: string, refs: Refs, attrAcc: Map<string, unknown>, nodeId: string) {
  let gid = gidOrAuto;
  // Intentional no-external-match leaf — attach a hand-authored schema if present.
  if (gid === "manual") {
    const ms = MANUAL_SCHEMAS[nodeId] ?? [];
    for (const a of ms) {
      const existing = attrAcc.get(a.key) as { values: Set<string> } | undefined;
      if (existing) for (const v of a.values ?? []) existing.values.add(v);
      else attrAcc.set(a.key, { handle: a.key, label: titleCase(a.key), values: new Set(a.values ?? []), provenance: { sources: [{ system: "manual" }] } });
    }
    return { name, shopify_ref: null, google_id: null, manual: true, attributes: ms.map((a) => ({ key: a.key, tier: a.tier })) };
  }
  if (gid === "auto") {
    const resolved = resolveGeneric(refs, name);
    if (!resolved) return { name, shopify_ref: null, error: "auto: no generic Shopify match — pin an explicit gid" };
    gid = resolved;
  }
  const cat = refs.byId.get(gid);
  if (!cat) return { name, shopify_ref: gid, error: "shopify gid not found" };
  // Normalize + merge near-duplicate handles (-color/-pattern/-material, renames),
  // unioning their Shopify value sets.
  const rawHandles = cat.attributes.map((a) => a.handle).filter((h) => !PRUNE_ATTRS.has(h));
  const normValues = new Map<string, Set<string>>();
  for (const rh of rawHandles) {
    const nh = normHandle(rh);
    const set = normValues.get(nh) ?? normValues.set(nh, new Set()).get(nh)!;
    for (const v of refs.attrValues.get(rh)?.values ?? []) set.add(v);
  }
  // Cap leaf breadth: required first, then recommended, then optional; alpha within.
  const capped = [...normValues.keys()]
    .sort((a, b) => TIER_RANK[tierOf(a)]! - TIER_RANK[tierOf(b)]! || a.localeCompare(b))
    .slice(0, LEAF_ATTR_CAP);
  for (const nh of capped) {
    const vals = normValues.get(nh)!;
    for (const v of refs.attrValues.get(nh)?.values ?? []) vals.add(v);
    const existing = attrAcc.get(nh) as { values: Set<string> } | undefined;
    if (existing) for (const v of vals) existing.values.add(v);
    else attrAcc.set(nh, { handle: nh, label: titleCase(nh), values: vals, provenance: { sources: [{ system: "shopify" }] } });
  }
  const g = refs.googleId.get(gid);
  return {
    name,
    shopify_ref: gid,
    shopify_path: cat.full_name,
    ...(g ? { google_id: g.id, google_path: g.path } : { google_id: null }),
    attributes: capped.map((h) => ({ key: h, tier: tierOf(h) })),
  };
}

interface CurationLeaf { [name: string]: string }
interface CurationCat { category: string; leaves?: CurationLeaf; children?: CurationCat[] }
interface CurationMap { department: string; tree: CurationCat[] }

function buildDept(map: CurationMap, refs: Refs, attrAcc: Map<string, unknown>) {
  const walk = (cats: CurationCat[], pathPrefix: string[]): unknown[] =>
    cats.map((c) => {
      const path = [...pathPrefix, c.category];
      const node: Record<string, unknown> = { name: c.category, node_id: [map.department, ...path].map(slug).join("/") };
      if (c.children) node.children = walk(c.children, path);
      if (c.leaves)
        node.leaves = Object.entries(c.leaves).map(([n, gid]) => {
          const nodeId = [map.department, ...path, n].map(slug).join("/");
          return { node_id: nodeId, ...buildLeaf(n, gid, refs, attrAcc, nodeId) };
        });
      return node;
    });
  return { department: map.department, node_id: slug(map.department), categories: walk(map.tree, []) };
}

async function main() {
  const args = process.argv.slice(2);
  const refs = await loadRefs();

  const listIdx = args.indexOf("--list");
  if (listIdx !== -1) {
    const gid = args[listIdx + 1]!;
    const parent = refs.byId.get(gid);
    if (!parent) return process.stderr.write(`no node ${gid}\n`);
    process.stdout.write(`${parent.full_name}\n`);
    for (const child of parent.children) {
      const c = refs.byId.get(shortId(child.id));
      if (c) process.stdout.write(`  ${shortId(c.id).padEnd(12)} ${c.name}  (${c.children.length} children)\n`);
    }
    return;
  }

  const only = args.includes("--dept") ? args[args.indexOf("--dept") + 1] : null;
  mkdirSync(LEAVES_DIR, { recursive: true });
  const files = readdirSync(CURATION_DIR).filter((f) => f.endsWith(".yaml") && (!only || f === `${only}.yaml`));
  const attrAcc = new Map<string, unknown>();

  for (const f of files) {
    const map = yaml.load(readFileSync(join(CURATION_DIR, f), "utf8")) as CurationMap;
    const out = buildDept(map, refs, attrAcc);
    const dest = join(LEAVES_DIR, f);
    writeFileSync(dest, "# GENERATED by scripts/seed/build-taxonomy.ts — edit the curation map, not this.\n" + yaml.dump(out, { lineWidth: 200 }));
    const leafCount = JSON.stringify(out).match(/"shopify_ref"/g)?.length ?? 0;
    process.stdout.write(`${f}: ${leafCount} leaves\n`);
  }

  const attrList = [...attrAcc.values()].map((a) => {
    const x = a as { handle: string; label: string; values: Set<string>; provenance: unknown };
    return { handle: x.handle, label: x.label, values: [...x.values], provenance: x.provenance };
  });
  writeFileSync(ATTR_OUT, "# GENERATED — shared canonical attributes (Shopify-sourced; tiers live on node_attributes).\n" + yaml.dump({ attributes: attrList }, { lineWidth: 200 }));
  process.stdout.write(`attribute-definitions.yaml: ${attrList.length} attributes\n`);
}

main().catch((e) => {
  process.stderr.write(`${e}\n`);
  process.exit(1);
});
