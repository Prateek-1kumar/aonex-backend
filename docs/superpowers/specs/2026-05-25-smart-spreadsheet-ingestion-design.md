# Smart Spreadsheet Ingestion (CSV / Excel → Catalog) — Design Spec

**Status:** Approved (brainstorming, 2026-05-25)
**Depends on:** the **Anomaly Lab staging core** (`admit-or-stage`, `staged_products`, gate) from
`2026-05-25-anomaly-lab-staging-gate-design.md`. That spec defers CSV to v2 (Decision 7, §13);
**this spec is that v2.** CSV converges at the `admitOrStage` chokepoint introduced there.
**Build sequencing:** the Lab staging core is built first (owner: separate effort); CSV work
starts once it lands. The CSV-specific upstream (intake, parsing, mapping, applier) is
independent and can be specced/planned in advance.
**Also reuses:** the completed catalog redesign — source adapters (`AdapterOutput`),
identity resolver, `writeAdapterOutput`, reconciler, category-schema system, the outbox; and
the link-adapter LLM/`BudgetTracker` extraction pattern.

---

## 1. Goal

A merchant drops an `.xlsx` or `.csv` of their stock list; the system auto-maps it to the
catalog and builds **one SKU per product** — with rollup attributes, a structured component
breakdown, and product images — with **no manual column-mapping step**. Genuinely incomplete
or anomalous SKUs are held in the Anomaly Lab (per the staging-gate model); everything clean
and confidently mapped enters the catalog automatically.

Two tracks, one pipeline:

- **Track A — Template (deterministic).** Merchant downloads our demo file (generated *from* a
  category schema), fills it, drops it. Column→attribute map is the **identity plan** — no LLM.
- **Track B — Smart (AI).** Merchant drops their own arbitrary file. We infer a **mapping plan**
  (heuristics + one LLM call per sheet), warn which columns weren't recognized, build SKUs, and
  let the gate route incomplete ones to the Lab.

Both converge on the same `MappingPlan` → deterministic applier → `AdapterOutput` →
`admitOrStage`. Track A is just the trivial identity plan.

---

## 2. Motivating input (the real file)

`Final Made Stock List WITH PICTURES.numbers` — an Indian gold/diamond jewelry stock list.
4 sheets (Earrings 66, Rings 81, Necklace 32, Bracelet 18 tagged products), 50 columns padded
to ~1000 rows, ~300 embedded photos. Defining structural traits the design must handle:

- **One product spans multiple rows** — a `Tag No.` line plus continuation rows, one per
  diamond/stone component, with the Tag/Picture/Gross-weight cells **vertically merged** across
  the group.
- **Images are floating media** anchored to cells (recoverable from `.xlsx` drawing anchors).
- **Messy, domain-specific headers** — trailing spaces, duplicate names (`Rate`×3, `Stp`×3),
  inconsistent column order across sheets, inconsistent karat casing.
- **No GTIN/MPN/brand/title** — `Tag No.` is the only identifier; price is computed from
  gold + component breakdown.

Decoded schema → §6.1 (jewelry category schemas).

---

## 3. Locked decisions (brainstorming, 2026-05-25)

| # | Decision | Implication |
|---|---|---|
| 1 | **No manual mapping UI.** Drop → auto-map → build each SKU. | AI infers the mapping; merchant never hand-maps columns. |
| 2 | **Two tracks.** Template (deterministic identity plan) + Smart (inferred plan). | One pipeline; Track A skips inference. Downloadable template generated from a category schema. |
| 3 | **Mapping = LLM-inferred plan, applied deterministically.** Heuristic pre-pass + one LLM call/sheet → a `MappingPlan`; code applies it to every row. | ~4 LLM calls for the whole file. Cheap, auditable, replayable. Plan cached per merchant. |
| 4 | **Input formats: `.xlsx` + `.csv`.** Merchant exports Numbers→Excel (one click). Not Apple Numbers natively. | `exceljs` preserves merged cells + image anchors; `csv-parse` for CSV. |
| 5 | **SKU model = rollup summary + full component breakdown.** | Searchable rollup attributes + a structured `components` JSONB attribute (bill-of-materials). Breakdown is source of truth. |
| 6 | **Images in v1 (Excel only).** Extract embedded photos, associate to SKU via anchor row. | CSV carries no images. |
| 7 | **Converge at `admitOrStage`.** CSV produces `AdapterOutput` and calls the Lab chokepoint, not `writeAdapterOutput`. | New product paths through the shared gate + staging + Lab. |
| 8 | **Satisfy `CANONICAL_MINIMUM` with data, not gate relaxation.** Inject merchant brand default; `Tag No.`→`primary_identifier`; synthesize `title`. | The Lab forbids per-tenant gate overrides; jewelry SKUs clear the bar via injected observations. |
| 9 | **Low mapping confidence = informational badge, not blocking.** | Confident-but-complete SKUs enter the catalog; `low-field-confidence` annotates. Genuinely missing required fields still stage. |
| 10 | **CSV Lab surface (evidence renderer) is owned here**; the Lab queue/workbench/dashboard are owned by the staging-gate effort. | We add a source-aware evidence pane for spreadsheet rows + mapping decisions. |

---

## 4. Architecture

```
  POST /api/ingestions/file  (.xlsx | .csv, multipart)
        │  validate → checksum → object storage (storageUri)
        │  INSERT source_artifacts (sourceType: spreadsheet|templated_csv, status=pending)
        │  enqueue FILE_INGEST job  →  202 { ingestionId }
        ▼
  Worker (csv lane)  ── CsvAdapter ──────────────────────────────────────────
        │
        │  normalize(input):
        │    1. fetch file from storageUri
        │    2. Grid normalizer → { sheets[]: headers, rows, mergedSpans, imageAnchors }
        │    3. per sheet: resolve MappingPlan
        │         cache hit (merchant, sheetSignature) → reuse  [Track A = template plan]
        │         miss → heuristic pre-pass + LLM gap-fill (BudgetTracker) → persist plan
        │    4. group rows into SKUs (grouping rule + merged spans)
        │    5. yield one IngestionEnvelope per SKU group
        │
        │  extract(envelope):
        │    apply plan → AdapterOutput (rollup attrs + components + images +
        │                 brand default + synthesized title; per-fact confidence + provenance)
        ▼
  new-catalog-csv-path.ts  →  admitOrStage(adapterOutput, ctx)   ← shared Lab chokepoint
        ├─ resolveIdentity (primary_identifier = Tag No., per-merchant; includeStaged)
        │     confident live match → enrich → writeAdapterOutput (re-upload = update)
        └─ evaluateGate (new product)
              pass → writeAdapterOutput → catalog_products
              fail → stageProduct → staged_products → Anomaly Lab
```

**New pieces vs. reuse:**

| Reused as-is | New / changed |
|---|---|
| Spine `IngestionAdapter` contract (`csv` lane + `CsvAdapter` slot already exist) | File upload endpoint (Hono multipart) + object-storage adapter (none exists today) |
| `AdapterOutput`, `writeAdapterOutput`, reconciler, identity resolver | Grid normalizer (`exceljs`/`csv-parse`) → uniform `Grid` |
| `admitOrStage` / gate / `staged_products` (built by the Lab effort) | Mapping-plan inference (heuristic + LLM gap-fill) + `ingestion_mapping_plans` cache |
| Category-schema system + LLM schema-drafting tool | Deterministic applier (grouping, rollups, components, brand default, title synth) |
| Link-adapter LLM infra + `BudgetTracker` | `CsvAdapter` (envelope-per-SKU) + worker `csv` lane wiring (remove the "not implemented" throw) + new queue |
| `source_artifacts` (`templated_csv`, `storageUri`, `checksum`) + audit/trace | Jewelry category schemas; image pipeline; template generator; frontend upload UX + CSV Lab evidence renderer |

---

## 5. Components

### 5.1 New files

| Path | Responsibility |
|---|---|
| `packages/ingestion/csv-parser/src/grid.ts` | Parse `.xlsx` (`exceljs`) / `.csv` (`csv-parse`) → `Grid = { sheets: [{ name, headers, rows, mergedSpans, imageAnchors }] }`. Strip padding; compute `sheetSignature` (hash of normalized headers + order). |
| `packages/ingestion/csv-parser/src/mapping-plan/heuristics.ts` | Exact/synonym/unit matching of headers → category-schema attributes. High-confidence easy matches. |
| `packages/ingestion/csv-parser/src/mapping-plan/infer.ts` | LLM gap-fill for unresolved/ambiguous columns + row-grouping rule + identity column + ignore list. `BudgetTracker`-capped. Returns `MappingPlan`. |
| `packages/ingestion/csv-parser/src/mapping-plan/types.ts` | `MappingPlan` = `{ columns: { index → { attribute, confidence } \| 'ignore' }, grouping: GroupingRule, identityColumn: number, category_path }`. |
| `packages/ingestion/csv-parser/src/apply.ts` | Given `Grid` + `MappingPlan`: group rows into SKUs, build rollup attrs + `components`, inject brand default + synth title, attach image refs → `AdapterOutput` per SKU with per-fact confidence + provenance. |
| `packages/ingestion/csv-parser/src/images.ts` | Extract `xl/media` bytes + anchors, map anchor row → SKU group, return `{ skuKey → image refs }`. |
| `packages/catalog/source-adapters/src/csv/adapter.ts` | `CsvAdapter implements IngestionAdapter` — `normalize` (Grid→plan→groups→envelopes) + `extract` (envelope→AdapterOutput). Wraps the csv-parser package. |
| `apps/api/src/handlers/file-ingestion.ts` | `POST /api/ingestions/file` (multipart): validate, checksum, store, insert artifact, enqueue. `GET /api/ingestions/template?category=…`. |
| `apps/api/src/services/object-storage.ts` | Storage adapter (S3-compatible): `putObject(key, bytes) → uri`, `getObject(uri)`. Used for raw files + extracted images. |
| `apps/worker/src/services/new-catalog-csv-path.ts` | Parallels link/shopify paths: run `CsvAdapter`, call `admitOrStage` per SKU. |
| `apps/worker/src/processors/file-ingestion.processor.ts` | Consume the file-ingest queue; drive `CsvAdapter.normalize`→`extract`→csv-path. |
| `seed/category-schemas/jewelry__rings.json` (+ `earrings`/`necklaces`/`bracelets`) | Jewelry category schemas (§6.1). Added to `authoritative-list.json`. |
| `packages/db/src/schema/ingestion-mapping-plans.ts` | Drizzle schema for the plan cache (§6.2). |
| `packages/db/migrations/00XX_ingestion_mapping_plans.sql` | Hand-written migration (catalog-redesign style). |
| Frontend `(authenticated)/ingestion/components/FileUpload.tsx` | `.xlsx`+`.csv` dropzone, template download, unrecognized-columns messaging, status. |
| Frontend Lab `evidence/SpreadsheetEvidence.tsx` | Source-aware evidence pane for CSV-staged SKUs: row-group + mapping decisions. |

### 5.2 Modified files

| Path | Change |
|---|---|
| `apps/worker/src/processors/ingestion-spine.processor.ts` | Remove `throw "Lane csv not implemented"`; route `csv` lane to the file processor. |
| `packages/db/src/schema/ingestion.ts` | Add `spreadsheet` to the `sourceType` enum (alongside `templated_csv`). |
| `apps/api/src/composition-root.ts` | Wire the file-ingestion route + queue + object-storage adapter. |
| `apps/api/src/handlers/ingestions.ts` | `getRecentIngestions`: include `spreadsheet`/`templated_csv` sources (currently `link_url`-only). |
| `packages/catalog/catalog-service/src/identity-resolver.ts` | Ensure `primary_identifier` (per-merchant SKU) matching path covers spreadsheet sources (no GTIN/MPN). |
| Frontend `src/lib/api.ts` | Fix `uploadCsv` → `POST /api/ingestions/file` (was the non-existent `/api/ingestion/upload`); add `downloadTemplate`, `getIngestionStatus`. |
| `apps/worker/src/.../QUEUE` registration | Add `FILE_INGEST` queue. |

### 5.3 Dependencies added
- `exceljs` (xlsx parse incl. merged cells + image anchors) — backend.
- Object-storage client (S3-compatible; e.g. `@aws-sdk/client-s3` or MinIO) — backend.
- (`csv-parse` already present.)

---

## 6. Data model

### 6.1 Jewelry category schemas (catalog map for both tracks)

Seeded `jewelry__rings | jewelry__earrings | jewelry__necklaces | jewelry__bracelets`
(existing `categorySchemas` shape). Sheet name → category. Two attribute layers:

**Rollup attributes (flat, searchable):**

| Attribute | Source col | Notes |
|---|---|---|
| `primary_identifier` | `Tag No.` | identity (per-merchant) |
| `supplier_ref` | `Ref No.` | |
| `metal_purity_karat` | `Stp` | normalize `14K/14k/14k `→`14` |
| `gross_weight_g`, `net_weight_g` | `Gr. Wt`, `Nt. Wt` | grams |
| `gold_value` | `Gd Px.` | INR |
| `total_diamond_carat`, `total_diamond_value` | `Dia T.Wt`, `Dia T.Px.` | |
| `total_labgrown_carat`, `total_labgrown_value` | `LG T.Wt`, `LG T.Px.` | |
| `total_stone_carat`, `total_stone_value` | `Stone Wt`, `Stn T.px` | |
| `making_charge` | `Lbr/Rs` | |
| `mrp` / `pricing.primary` | `MRP` | currency default **INR** |
| `certification_lab` | `SGL` | GIA/IGI/SGL |
| `hallmark_huid` | `H/M`/`Stock` | |
| `diamond_colour/clarity/cut` | `colour/clarity/cut` | summary 4Cs |
| `availability_location` | `Availibility at HK` | |
| `stock_status` | `Stock (30/6)` | |
| `brand` | **injected** | merchant store name (default obs, low priority) |
| `title` | **synthesized** | e.g. "14K Gold Diamond Ring — RG19" (low-priority obs) |
| `images` | image anchors | §7 |
| `category_path` | sheet name | jewelry__rings, etc. |

**`components` — structured nested attribute (one atomic JSONB attribute):**
```jsonc
"components": [
  { "type": "natural_diamond" | "labgrown" | "stone",
    "quality": "RND1/3", "shape": "RND", "pieces": 1, "weight_ct": 0.38,
    "rate": 26000, "value": 9880, "colour": "E-F", "clarity": "VVS",
    "cut": null, "certification": "CERT" }
]
```
Reconciler treats it atomically (one observation → one winner). Rollups derive from it.

**Variant axes:** none — each `Tag No.` is one unique physical piece (`variantOptions` empty).

### 6.2 `ingestion_mapping_plans` (new — the cache / fast path)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id`, `merchant_id` | fk | tenant-scoped |
| `sheet_signature` | text | hash of normalized headers + order |
| `category_path` | text | resolved target category |
| `plan` | jsonb | `MappingPlan` (§5.1) |
| `source` | text | `template` \| `heuristic` \| `llm` |
| `version` | int | |
| `created_at` | timestamptz | |

Unique `(merchant_id, sheet_signature)`. Template signatures pre-seeded as `source='template'`.

### 6.3 Other persistence
- `source_artifacts.sourceType` += `spreadsheet`. Raw file → `storageUri`; small CSV may inline
  `rawData`. `checksum` dedup short-circuits identical re-uploads.
- Track-B columns the LLM maps to attributes **not** in the base schema → existing
  `category-attribute-promotion-candidates` (captured, promotable), not dropped.
- Catalog observations land via the existing 4-axis pattern in `catalog_products.values`
  (`{ source: "spreadsheet:<file>", value, confidence, observedAt, channelScope }`). No catalog
  schema change.

---

## 7. Images (Excel only)

`.xlsx` stores images in `xl/media/`; `xl/drawings/*.xml` two-cell/one-cell anchors pin each to a
cell (`<xdr:from>` row/col). `exceljs` exposes `worksheet.getImages()` (anchor ranges) +
`workbook.model.media` (bytes).

1. For each image, take its top-left anchor row.
2. Map that row to its SKU group via the grouping rule / merged-span the picture cell occupies.
3. Upload bytes to object storage → URL; attach as the SKU's `images` observation (first = hero).
4. Ambiguous anchor (between groups) → nearest group above + `low-confidence` image badge.

CSV carries no images — stated to the merchant in the UI.

---

## 8. Data flow

### 8.1 Track B — arbitrary jewelry `.xlsx`
```
1. Drop file → POST /api/ingestions/file → 202 { ingestionId }; FILE_INGEST job.
2. Worker fetches file; Grid normalizer → 4 sheets w/ merged spans + image anchors.
3. Per sheet: cache miss → heuristic pre-pass maps Gr.Wt/Nt.Wt/MRP/Tag No.; LLM gap-fill
   resolves Gd Px., Lbr/Rs, LG/Dia/Stone blocks, duplicate Rate/Stp, grouping rule. Persist plan.
4. Group rows by Tag No. + merged spans → SKU groups (RG19 + its component rows = one group).
5. Per group → AdapterOutput: rollups + components[] + image refs + brand default + synth title;
   per-fact confidence; provenance (sheet, rows). Ignored columns recorded (UI warning).
6. new-catalog-csv-path → admitOrStage:
   - resolveIdentity(primary_identifier=RG19) → no live match → evaluateGate.
   - complete + confident → writeAdapterOutput → catalog.
   - missing MRP / impossible price / identity conflict → stageProduct → Lab.
7. UI: "Recognized 18 columns, 3 unrecognized. Built 74 SKUs, 7 in Lab." Lab shows held SKUs
   with the SpreadsheetEvidence pane (row-group + mapping decisions).
```

### 8.2 Track A — template
Steps 1–2, then step 3 hits the known template `sheetSignature` → identity plan (no LLM) →
steps 4–7. Fully deterministic.

### 8.3 Re-upload (idempotent enrich)
Edited file, same signature → cached plan reused; SKUs re-resolve by `Tag No.` →
`admitOrStage` matches live products → enrichment (per-channel append), no duplicates.
Identical file → checksum dedup short-circuits at intake.

---

## 9. Error handling

| Failure | Behavior |
|---|---|
| Corrupt/unreadable file | artifact `failed`; ingest failure card (reuse `extraction_failures`); no SKUs. |
| No identity column / empty sheet | sheet skipped with clear reason; other sheets proceed. |
| Duplicate headers (`Rate`×3, `Stp`×3) | plan disambiguates by position + component block; applier addresses columns **by index**. |
| Continuation row w/ no anchor | grouping rule attaches to the open group. |
| LLM call fails / budget exceeded | fall back to heuristic-only plan; unmapped → ignored + surfaced; missing-required SKUs → stage. Never fail whole file. |
| Per-SKU extraction error | that SKU → `extraction_failures`; rest of file proceeds (partial success). |
| Image anchor unresolved | low-confidence image obs + badge; never fatal. |
| Replay | raw file in storage + persisted plan → deterministic re-run; no re-LLM. |
| Locale numbers | Indian formats parsed; reuse/extend `parseNumber`. |

---

## 10. Frontend

- **Upload** (`FileUpload.tsx`): `.xlsx`+`.csv` dropzone; fix path → `/api/ingestions/file`
  (was non-existent `/api/ingestion/upload`); progress + busy state.
- **Template download**: per-category button → `GET /api/ingestions/template?category=…` →
  CSV with canonical headers + one example row (generated from the category schema).
- **Track-B messaging**: post-parse summary — recognized vs. unrecognized columns; built /
  staged / failed counts; link to the Lab.
- **Recent ingestions**: include `spreadsheet`/`templated_csv` (fix `link_url`-only filter).
- **Lab evidence** (`SpreadsheetEvidence.tsx`): for CSV-staged SKUs, render the source row-group
  (the merged product block) + the mapping decisions (column → attribute + confidence). Plugs
  into the Lab's source-aware evidence pane. (Lab queue/workbench/dashboard owned by the
  staging-gate effort.)

---

## 11. Testing

- **Unit (no DB):** grid normalizer (xlsx merged cells, image anchors, csv); `sheetSignature`;
  heuristic matcher; applier (grouping, rollups, `components`, brand default, title synth,
  by-index duplicate-header handling); locale number parsing.
- **Mapping inference:** fixtures with a **mocked LLM** (deterministic plan); **golden test** on
  a redacted slice of the real file — assert product count and that **RG19 builds with its
  component breakdown + correct rollups**.
- **AdapterOutput:** known row-group → expected observations + components + confidence + provenance.
- **Integration (real Postgres, once staging core lands):** upload → `admitOrStage` routing —
  complete→catalog, missing-required→staged, re-upload→enrich (no dup), identical→dedup.
- **Images:** xlsx with anchored images → correct SKU association + storage upload (mocked storage).
- **E2E (Playwright):** drop the jewelry `.xlsx` → N SKUs in catalog, M held in Lab with the
  SpreadsheetEvidence pane, images attached; template round-trip (download → fill → upload →
  deterministic build, no LLM).
- **Coverage:** every path in `grid`, `infer`, `apply`, `images`, `new-catalog-csv-path`; each
  §9 failure mode ≥1 test.

---

## 12. Phasing (starts after the Lab staging core lands)

0. **[Prereq — separate effort]** Lab staging core: `admitOrStage`, `staged_products`, gate.
1. **Intake + storage:** upload endpoint, object-storage adapter, `source_artifacts` wiring,
   `FILE_INGEST` queue, worker `csv` lane (remove the throw), `CsvAdapter` skeleton →
   `admitOrStage`.
2. **Grid + schemas:** grid normalizer (xlsx+csv, merged cells, image anchors); jewelry category
   schemas drafted + seeded.
3. **Mapping + applier:** heuristic pre-pass + LLM gap-fill + `ingestion_mapping_plans` cache;
   deterministic applier (grouping, rollups, components, brand default, title synth).
4. **Images:** extraction + storage + association.
5. **Template (Track A):** template-generation endpoint + identity-plan fast path + seeded
   template signatures.
6. **Frontend:** upload UX, template download, unrecognized-columns messaging, status,
   recent-list fix, CSV Lab evidence renderer.
7. **Hardening:** golden test on the real file, partial-failure handling, replay, idempotent
   re-upload.

---

## 13. Out of scope (v2+)

- Apple Numbers native parsing (merchant exports to `.xlsx`/`.csv`).
- The Lab queue/workbench/dashboard UI (owned by the staging-gate effort; we add only the CSV
  evidence pane).
- Non-jewelry verticals (the approach is generic; only jewelry schemas are seeded in v1).
- Bulk image re-association / manual image attach UI.
- Per-tenant override of `CANONICAL_MINIMUM` (forbidden by the Lab spec).
- Streaming/very-large-file (>~100MB) handling beyond a single worker job.
