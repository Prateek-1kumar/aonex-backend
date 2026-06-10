# Taxonomy Spine — P0 Build Spec (Foundation)

**Status:** DRAFT for sign-off. No implementation until approved.
**Author:** Claude (with service.desk@aonamitech.com)
**Date:** 2026-06-10

---

## 0. Locked decisions (context)

This spec assumes the design we settled on:

1. **Canonical tree = Aonex's own marketplace-style taxonomy** (~70 departments supplied by the
   owner), organized `department › category › leaf`, **3–4 levels** deep. Full **breadth up front**;
   **depth grows** later via the enrichment/promotion loop.
2. **Google Product Taxonomy is an EXPORT MAP only** — each leaf maps to a Google category (via the
   generic crosswalk table, alongside any other marketplace) for correct feeds. It is not the
   structural backbone, and it is not privileged over other external systems.
3. **Gender/age = ATTRIBUTES** (`target_gender`, `age_group`), not tree nodes. "Men's/Women's/Kids"
   are browse facet-views over one gender-neutral leaf.
4. **Fresh `taxonomy_nodes` table** for tree structure, kept SEPARATE from attribute schemas.
5. **Canonical-path invariant:** a product's category is ALWAYS a `node_id` to a real node — free
   text never enters, from ingestion or humans. The Lab is a constrained tree picker. Classification
   assigns the **deepest node the evidence justifies**; ambiguity routes to the Lab.
6. **Industry-standard per-leaf attribute schemas**, built for **every current leaf, up front**, by
   **merging multiple authoritative references** (Shopify Standard Product Taxonomy + Google product
   data spec + Amazon category requirements + GS1 GPC), then **expert-curating and extending** into
   *our own* owned, versioned attribute model. References are ingested **once as a seed** into our
   tables — not a runtime dependency, free to diverge. The 151 LLM-drafted schemas are hints only.
7. **Category is structural → decide-once-and-sticky:** not re-reconciled every connector sync the
   way price/stock are. A Lab-confirmed category is ground-truth; cross-source node disagreement is a
   Lab signal, never a silent flip.
8. **Everything is gated by an eval/golden-set.**

---

## 1. Goal & scope

**P0 delivers the foundation everything else is measured against:** the canonical taxonomy tree, the
industry-standard per-leaf attribute schemas, the supporting tables/migrations, and the eval +
golden-set harness.

**P0 explicitly does NOT include** (these are later phases, listed in §8):
- the ingestion-phase category classifier (P1),
- the Lab category-confirmation UX (P1),
- attribute enrichment (P2),
- the CSV parser rebuild (P3).

So in P0, **products are not yet auto-categorized** — P0 builds the tree, schemas, and the ruler we
measure against. P1 makes classification live.

### Success criteria (verifiable)

- **Tree:** every one of the ~70 departments is organized into the tree; every leaf has a Google
  `export` mapping and ≥1 `schema_source` mapping (the references merged for it) in
  `taxonomy_node_mappings`; a structural validator passes (single rooted path per node, no orphans,
  every leaf reachable, no duplicate display paths).
- **Schemas:** every leaf has ≥1 `required` attribute; 100% of attribute references resolve to an
  `attribute_definitions` row; a human has signed off on a reviewed sample across all departments.
- **Eval:** a golden set of ≥150 real, messy-input products (spread across departments) is loaded;
  the harness emits classification + attribute metrics; **baseline numbers recorded** against today's
  system so future phases show lift.
- **Migration:** `catalog_products.category_node_id` column + FK exist; the alias table is seeded;
  existing `category_path` strings that exact-alias-match are pre-mapped (no classifier needed).

---

## 2. Data model

New/changed tables live in `packages/db` (Drizzle schema + `node-pg-migrate` migrations), following
existing conventions (branded IDs, `snake_case` columns, jsonb where noted).

### 2.1 `taxonomy_nodes` — the tree (NEW)

| column | type | notes |
| --- | --- | --- |
| `node_id` | text PK | stable slug path, e.g. `fashion/clothing/bottoms/jeans` |
| `parent_id` | text FK→`taxonomy_nodes` | null only for departments (roots) |
| `level` | int | 0=department … 3–4=leaf |
| `display_name` | text | "Jeans" |
| `display_path` | text | "Fashion › Clothing › Bottoms › Jeans" (derived, stored for browse) |
| `is_leaf` | bool | leaves carry attribute schemas + are assignable targets |
| `status` | enum(`active`,`draft`,`deprecated`) | `draft` = proposed by promotion loop, pending review |
| `sort_order` | int | display ordering within a parent |
| `created_at`/`updated_at` | timestamptz | |

Indexes: `parent_id`, `status`, unique `display_path`.

> **No per-system columns.** Google (export), Shopify (schema source), and every future marketplace
> live as rows in `taxonomy_node_mappings` (§2.6). Adding Amazon/Flipkart/eBay/… is inserting data,
> never a schema migration. The tree itself stays system-agnostic.

### 2.2 `taxonomy_aliases` — raw label → node (NEW)

The normalization + learning layer. Collapses `t_shirt`/`T_Shirt`/`tshirt`/`tee` → one node, and the
per-marketplace category vocabularies (Amazon "Cell Phones", Flipkart "Smartphones") → one node.

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `normalized_label` | text | lowercased, depluralized, punctuation-stripped |
| `source_context` | text null | e.g. `shopify`, `amazon`, `csv`, `*` (any) |
| `node_id` | text FK→`taxonomy_nodes` | the canonical target |
| `origin` | enum(`seed`,`human`,`learned`) | provenance; `human` = Lab confirmation |
| `confidence` | real | 1.0 for seed/human; learned ones carry a score |
| `created_at` | timestamptz | |

Indexes: unique(`normalized_label`,`source_context`), `node_id`.
Seeds from: Shopify/Google category synonyms, the existing `category_schemas.marketplaceMappings`, and
a hand list of common variants.

### 2.3 `attribute_definitions` — shared canonical attributes (REUSE/EXTEND existing)

One row per canonical attribute (`fabric`, `color`, `pattern`, `target_gender`, `waist_rise`, …) with
its **value set** — sourced from Shopify so "Denim" means Denim across every apparel leaf. Reconcile
with the existing `attribute_definitions`/`attributes` tables rather than adding a rival (see §2.6).

| column | type | notes |
| --- | --- | --- |
| `handle` | text PK | `fabric`, `target_gender`, `waist_rise` |
| `label` | text | "Fabric" |
| `data_type` | enum(`string`,`number`,`boolean`,`array`,`object`) | |
| `value_set` | jsonb null | enum values, e.g. `["Cotton","Denim",…]` (null = free value) |
| `unit_type` | text null | `mass`,`length`,`data`,… for numeric attrs |
| `min`/`max` | numeric null | numeric range constraints |
| `source` | text | `shopify`,`google`,`amazon`,`gs1`,`manual` (provenance; an attr may merge several) |
| `source_ref` | text null | the Shopify attribute gid |

### 2.4 `node_attributes` — the per-leaf schema (NEW, normalized)

The join that *is* a leaf's attribute schema: which attributes apply, at what tier.

| column | type | notes |
| --- | --- | --- |
| `node_id` | text FK→`taxonomy_nodes` | leaf |
| `attribute_handle` | text FK→`attribute_definitions` | |
| `tier` | enum(`required`,`recommended`,`optional`) | drives completeness + the gate |
| `is_variant_axis` | bool | true for `size`, `color` where they define variants |
| `sort_order` | int | |

PK(`node_id`,`attribute_handle`).

> **Validation engine — purpose-built, not Ajv.** A focused **validation + normalization module**
> reads `node_attributes` + `attribute_definitions` directly, because our real need is *normalize*,
> not just accept/reject:
> - **enum coercion** — exact → case-insensitive → fuzzy/synonym (`"blue denim"` → `Denim`), else
>   `invalid` with nearest-candidate suggestions;
> - **unit parsing/normalization** — `"256 GB"` → `{value:256, unit:GB}`, convert to canonical unit;
> - **numeric range** checks (min/max);
> - **3-tier scoring** — required (blocking) / recommended / optional (partial credit), not JSON
>   Schema's binary `required`;
> - **structured per-attribute outcome** — `{status: ok|coerced|invalid|missing, value, normalized,
>   suggestion, message}` consumed by the admission gate, the Lab, the enrichment verifier, and the
>   eval's schema-violation metric.
>
> Pure function over `(leaf schema, attributes)`. JSON Schema/Ajv can't do the normalization half, and
> forcing the normalized model through a compile-to-Ajv step buys little, so we don't. We can still
> *emit* a JSON Schema per leaf as an **output** for external consumers (API/marketplace) if needed.
> This replaces the hand-maintained `category_schemas.jsonSchema` blobs.

### 2.5 `catalog_products.category_node_id` (CHANGE)

Add `category_node_id text null FK→taxonomy_nodes` + index. The free-text `family`/`category_path`
stay for one transition period (read-only fallback), then are dropped in a later phase. Populated by
the P1 classifier; in P0 it is added (nullable) and pre-filled only for exact alias hits.

### 2.6 `taxonomy_node_mappings` — external-system crosswalk (NEW)

The generic, pluggable bridge between our canonical tree and **any** external taxonomy — Google (feed
export), Shopify (where we sourced the attribute schema), and Amazon / Flipkart / eBay / Walmart and
future marketplaces (import *and* export). One row per (node, system, role). **Adding a marketplace
is inserting rows, not a schema change.**

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `node_id` | text FK→`taxonomy_nodes` | our canonical node |
| `system` | text | `google`,`shopify`,`amazon`,`flipkart`,`ebay`,`walmart`,… |
| `external_id` | text null | external category id / gid / browse-node id |
| `external_path` | text null | external full-path label (display/debug) |
| `role` | enum(`export`,`import`,`schema_source`,`reference`) | what the mapping is used for |
| `is_primary` | bool | preferred mapping when a system has several |
| `confidence` | real | 1.0 curated; <1 auto-proposed pending review |

Unique: (`node_id`,`system`,`role`); index (`system`,`external_id`).
- **export** — node → external category per marketplace feed (Google id, Amazon browse node, …).
- **import** — a connector's structured category id → node (deterministic; complements the *string*
  matching in `taxonomy_aliases`).
- **schema_source** — records the external category/categories this leaf's attributes were merged
  from (Shopify `aa-1-12-4` + the Google/Amazon/GS1 equivalents). Provenance, not privilege.

> **Aliases vs mappings:** `taxonomy_aliases` (§2.2) maps *messy strings/labels* → node (learned,
> grows over time). `taxonomy_node_mappings` maps *structured external ids* ↔ node (curated,
> bidirectional, drives feed export). Both feed the P1 classifier's deterministic layer.

### 2.7 Relationship to existing tables (what we keep / supersede / migrate)

- **`category_schemas`** (path-keyed JSON-Schema + `marketplaceMappings` + `variantOptions`):
  *superseded.* Its `marketplaceMappings` seed `taxonomy_aliases`; its `variantOptions` inform
  `is_variant_axis`; its `jsonSchema` content is replaced by Shopify-sourced `node_attributes`. Keep
  the table during transition; mark deprecated when migration is verified.
- **`attribute_definitions` / `attributes`** (existing canonical-attr + lookup tables, used by the
  semantic-mapper): **extend, don't duplicate.** Populate value sets from Shopify; keep the mapper's
  lookups working.
- **`schema-validator` package (Ajv 2019):** **retained on the legacy extraction path** it already
  serves — NOT ripped out in P0. The new taxonomy validates via the purpose-built
  validation+normalization module (§2.4); legacy callers migrate to it in a later phase.
- **`category-labels`, `tenant-category-overlays`, `category-attribute-promotion-candidates`:** keep;
  re-point at `node_id` (the promotion-candidates table becomes the node/attribute promotion loop).
- The **151 `seed/category-schemas/*.json`** files: retained as *hints* for the sourcing pipeline
  only; not loaded at runtime.

---

## 3. Content sourcing pipeline (tree + schemas)

How the actual tree + schemas get produced. LLM-assisted, **human-verified** — the verification pass
is mandatory (it is what makes these "authoritative", unlike the current unverified 151).

**Step 3.1 — Author the tree skeleton.** Turn the ~70-department list into structured
`department › category` (levels 0–1). Human-authored seed file (`seed/taxonomy/nodes.yaml`).
*Verify:* every department + category from the list is present; reviewer signs off.

**Step 3.2 — Deepen to leaves using Shopify as the depth reference.** For each category, map to the
matching Shopify subtree and adopt the relevant leaves (3–4 deep), pruning ones Aonex won't sell.
*Verify:* structural validator passes; no orphan leaves; depth ≤ 4 except where explicitly allowed.

**Step 3.3 — Map each leaf to external systems (via `taxonomy_node_mappings`).** Write a
`schema_source` mapping → Shopify category gid (where the attributes came from) and an `export`
mapping → nearest Google id. The same table later carries Amazon/Flipkart/eBay export+import rows —
data, not schema. Auto-propose, human-confirm the non-exact ones. *Verify:* every leaf has a Shopify
`schema_source` + a Google `export` mapping (or an explicit "no equivalent" marker).

**Step 3.4 — Merge multi-source attribute schemas.** For each leaf, gather candidate attributes from
**all reference sources** (Shopify category, Google product spec, Amazon category requirements, GS1
GPC brick) → merge/dedup the union into `attribute_definitions` (canonical handle + merged value set,
with per-source provenance) → write `node_attributes`. Assign tiers by rule: attributes
Google/marketplaces *require* → `required`; the rest → `recommended` / `optional`. The 151 old schemas
are consulted as hints only. *Verify:* every leaf has ≥1 required attribute; all handles resolve.

**Step 3.5 — Human verification, junk-pruning & Aonex extensions.** A reviewer walks each
department's schemas, prunes junk, fixes tiers and value sets, marks `size`/`color` variant axes, and
**adds Aonex-specific attributes** where we want to go beyond the references. This is THE curation
gate — it is what makes the schemas *ours* and authoritative (unlike the unverified 151).
*Verify:* sign-off recorded per department.

**Step 3.6 — Seed aliases.** Populate `taxonomy_aliases` from Shopify/Google synonyms + existing
`marketplaceMappings` + a hand list of common variants (`t_shirt`,`tee`,…). *Verify:* spot-check that
known messy labels resolve to the right node.

**Output artifacts:** `seed/taxonomy/{nodes,attributes,node-attributes,aliases}.*` + a one-shot
`scripts/seed/insert-taxonomy.ts` loader (mirrors the existing `insert-category-schemas.ts`).

---

## 4. Eval & golden set (the gate)

**4.1 Golden set.** ≥150 real products with messy inputs (drawn from `test-data/` + scraped/connector
samples), each hand-labeled with: the **correct `node_id`** and the **correct attribute values** per
that node's schema. Spread across all departments; split `regression` / `holdout`. Stored under
`packages/ingestion-eval/fixtures/golden-taxonomy/`.

**4.2 Harness.** Extend the existing `ingestion-eval` scorer (`scoreProduct`/`aggregate`) to score:
- **Classification:** predicted node vs golden — exact-match + partial credit for correct ancestor
  (so "right department, wrong leaf" scores above "wrong department").
- **Attribute fill:** per-field accuracy vs golden (reusing weighted precision/recall).
- **Schema violation rate:** % of produced attribute values that fail the validator (range/enum/unit).
- **Hallucination rate:** % of produced facts not supported by the input (fact-tuple check).

**4.3 Baseline.** Run today's system through the harness and record the numbers. This is the
"presentable-school-project" baseline every later phase is measured against.

*Verify:* harness runs in CI against the golden set and prints the metric table.

---

## 5. Migration & backfill

1. Migration adds `taxonomy_nodes`, `taxonomy_aliases`, `node_attributes`, extends
   `attribute_definitions`, adds `catalog_products.category_node_id` (nullable + FK + index).
2. Seed loader inserts the verified tree + schemas + aliases.
3. **Backfill of existing products** is *deferred to P1* (it needs the classifier). In P0 we only
   pre-map products whose current `category_path` exact-alias-matches a node — pure data, no model.
4. Rollback: migrations are reversible; the new tables are additive; `category_node_id` is nullable
   so nothing breaks if unpopulated.

---

## 6. Sequencing (ordered tasks, each with a verify check)

| # | Task | Verify |
| --- | --- | --- |
| 1 | Pin/confirm reference sources (Shopify release, Google spec, Amazon category data, GS1 GPC) + their license terms | sources + licenses noted in `docs/` |
| 2 | Drizzle schema + migrations for the 5 tables + the `catalog_products` column | `db:migrate` up/down clean; typecheck green |
| 3 | Tree skeleton seed from the ~70 departments (§3.1) | structural validator passes |
| 4 | Deepen + map leaves via `taxonomy_node_mappings` (§3.2–3.4) | every leaf has Google+Shopify mappings + ≥1 required attr |
| 5 | Human verification + junk-prune (§3.5) | per-department sign-off |
| 6 | Alias seed (§3.6) | known messy labels resolve correctly |
| 7 | Seed loader + insert | row counts match seed; tree queryable |
| 8 | Golden set labeled (§4.1) | ≥150 labeled, split recorded |
| 9 | Eval harness extension + baseline (§4.2–4.3) | metric table prints; baseline recorded |

Gates run throughout: `bun run typecheck`, `depcheck`, `lint` stay green (existing CI contract).

---

## 7. Open items / assumptions

- **Reference licenses:** confirm terms before vendoring each source (Task 1) — Shopify (published
  for adoption), Google spec (open), Amazon category data, and **GS1 GPC** (has its own access/license
  terms — verify before use). Any source with restrictive terms is dropped from the merge; the
  remaining ones still give a strong floor.
- **Leaf count:** organizing ~70 departments at 3–4 deep yields an estimated few-hundred leaves; the
  exact count comes out of §3.2 and sizes the verification effort.
- **Size modeling:** `size` is a variant axis, not a flat attribute, for apparel/footwear
  (`is_variant_axis=true`); confirm the per-department list during §3.5.
- **Golden-set labeling owner:** who hand-labels the 150 products (us + a domain reviewer?) — needed
  for §4.1.
- **`node_id` scheme:** slug-path proposed (human-readable, stable). Alternative: opaque uuid + path
  column. Slug-path chosen for debuggability; confirm.

---

## 8. Deferred to P1+ (explicitly NOT in P0)

- **P1 — ingestion spine:** the category classifier (alias → taxonomy-constrained ML/LLM fallback →
  calibrated confidence → auto-assign or Lab), runs on every ingestion path; backfill of existing
  products; the Lab constrained-tree-picker confirmation UX + alias learning loop; export mapping
  (node → GPT id + gender attribute); the category-sticky reconciler rule.
- **P2 — enrichment:** catalog-grounded attribute enrichment against the node schema, extract →
  normalize → verify (Ajv + fact-tuple), calibrated per-field confidence, node-deepening proposals.
- **P3 — CSV parser rebuild:** locale/encoding/variant/streaming hardening for worst-case input.

---

*End of P0 spec. Awaiting sign-off before implementation.*
