# Aonex Unified Ingestion Design

**Date:** 2026-05-16
**Status:** Draft for review
**Scope:** Phase 1 of catalog ingestion overhaul — unified link / CSV / Nango ingestion into a single canonical catalog with per-category schema validation and a Tiered Schema Maturity model.
**Supersedes:** Nothing formally; implements the unbuilt parts of `docs/Aonex_Production_HLD_Catalog_Ingestion_Distribution_v2.docx` (henceforth "HLD") and corrects schema gaps in the current implementation.
**Out of scope (deferred):** Multi-channel projection (`channel_projections`, marketplace publish, sync reconciliation), public typed-SDK / API hardening, governance UI.

---

## 1. Executive summary

The current Aonex backend ships three ingestion personalities — a 465-line link-extract worker, a stub CSV parser, and a Nango drain that stops at `source_artifacts` — and a canonical schema (`product_versions`) that is missing `attributes_json`, `weight_grams`, `dimensions_cm`, `manufacturer_part_number`, `category_schema_version`, `category_confidence`, and `evidence_summary`. The result: structured extractors correctly pull `screen_size: 55`, `display_type: OLED`, `ram_gb: 8` and these values get silently buried in a `merchant_extensions_json` blob; `category_schemas.json_schema` exists but is never enforced; the three ingestion lanes share neither a contract nor a pipeline.

This spec replaces the three personalities with **one ingestion spine** fed by three `IngestionAdapter` implementations, fixes the canonical schema to the HLD's 4-layer model, and adds a **Tiered Schema Maturity** model (Authoritative → Inferred → Promoted) so the system handles "any product, accurately, across all sectors" without requiring hundreds of hand-authored category schemas at launch. Extraction quality is closed against industry standard via a layered parser stack (structured-data → DOM heuristics → browser → vendor anti-bot → LLM gap-fill → vision LLM → per-site parsers → multi-source verification).

The product story this enables: *Diffbot-grade extraction → Akeneo-grade canonical → unified for three lanes.*

The full design references three field-reconnaissance briefs gathered during the design conversation: a 2026 state of the art for product link extraction, a comparison of mature PIM/catalog architectures (Akeneo, Salsify, Plytix, Pimcore, Amazon SP-API Product Type Definitions, GS1 GDSN), and a survey of quality + observability patterns for production extraction systems. Citations in §20.

---

## 2. Scope, goals, non-goals

### 2.1 In scope

- **Link lane built end-to-end** as the primary deliverable: full extraction pack (Layers A–H), unified spine, canonical write-through, review, promotion, observability, cost tracking
- **CSV lane built from the templated parser through the same spine and canonical model**
- `IngestionAdapter` contract introduced for Link and CSV; the canonical schema, validator, scoring, diff, and approval are SHARED across lanes
- Canonical schema repair: `product_versions` columns + JSON Schema validator + Tiered Schema Maturity
- Hybrid Google Product Taxonomy adoption with selective leaf-schema authoring
- LLM-drafted seed schemas (~150 categories at launch) + admin refinement of top ~30
- Link extraction pack: structured-data parsers, DOM heuristics, browser fallback, vendor anti-bot, LLM gap-fill, vision LLM tier-3, per-site parser registry, multi-source verification by GTIN
- Templated CSV lane per HLD §11.3 (header-locked, deliberately not loose)
- Promotion job: Inferred → Promoted → Authoritative schema graduation
- Multi-tenancy: tenant-scoped data, per-tenant overlays via JSON Schema `allOf`, per-tenant mapping overrides
- Operations: queues, retries, DLQ, idempotency, cost ledger, runbooks, dashboards, SLOs
- Quality: golden datasets, per-field accuracy, drift detection, selector health, confidence calibration, shadow-mode rollouts
- Security: RLS, RBAC, credential vault, prompt-injection defense

### 2.1.1 Nango lane — explicitly preserved, not refactored in this phase

The Nango marketplace connector path (`apps/nango/*`, `apps/worker/src/processors/nango-sync.processor.ts`, `nango-auth.processor.ts`, `drain.processor.ts`, `apps/api/src/routes/webhooks.ts`, `apps/api/src/routes/connections.ts`, `packages/connector-gateway/*`) is built and maintained by a separate engineer and is OUT OF SCOPE for refactoring in this design. The only crossing point: marketplace-sourced products land in the canonical model via the SAME `applyApprovedDiff` after this design's canonical-schema fix ships, so they automatically benefit from `attributes_json` + JSON Schema validation. No Nango processor code is touched. Coordination with the Nango engineer happens at the canonical-model boundary, not inside the connector path. The previously-described "NangoAdapter" remains a future option for the Nango engineer to opt into when convenient; it is not part of this delivery.

### 2.2 Goals

| Goal | Acceptance shape |
|------|------------------|
| Three lanes share one pipeline | No bespoke lane-specific approval path; all approvals go through `applyApprovedDiff` |
| Canonical schema is "healthy" | `product_versions` carries every HLD §8.1 field; `attributes_json` is validated against `category_schemas.json_schema` per tier |
| Any product type extracts cleanly | A tent, an umbrella, a TV, a phone, a t-shirt, a sofa all produce a `product_version` with at least Layer 1 + best-effort Layer 3 |
| Tier 1 categories validate strictly | Missing required attribute → `review_task`, not silent acceptance |
| Tier 2 categories degrade gracefully | Anything that parses gets stored with LLM-inferred attrs; no "unsupported category" failures |
| Extraction is industry standard | Coverage across Shopify, Amazon, Decathlon, WooCommerce, Magento, random WP, behind-Cloudflare sites |
| Evidence preserved per fact | Every `extracted_facts` row carries `source_pointer`, `extraction_method`, `confidence`, `mapping_candidates`, `source_alternatives` |
| Auditable end-to-end | Every state transition emits an `audit_event`; every approved version traces to one approved `proposed_diff` |
| Multi-tenant safe | RLS on hot tables; per-tenant noisy-neighbor isolation |
| Cost-tracked | Per-extraction cost ledger; per-tenant budget caps |

### 2.3 Non-goals for this phase

- Channel projection / multi-marketplace publish (HLD §16) — deferred
- Direct marketplace adapters beyond Nango — deferred
- Public typed SDK / API hardening — deferred
- Governance UI beyond Anomaly Lab basics — deferred
- Loose CSV header mapping (HLD §2.3 explicit non-goal at V1)
- PDF ingestion (HLD non-goal)
- Browser ingestion for tenant-authenticated content (legally complex; deferred)

---

## 3. Locked architectural decisions

| ID | Decision area | Choice | Rationale |
|----|---------------|--------|-----------|
| ADR-AON-001 | Canonical schema model | Typed Layer 1 + Layer 2 columns + jsonb Layer 3 + Layer 4 listings (later) | HLD §8.1; confirmed by PIM brief — Pimcore + Akeneo Family Variants + Bloomreach jsonb arrays all converge here; pure-jsonb (Salsify) loses Postgres typed-column performance, EAV (legacy Akeneo) is slow at filter time |
| ADR-AON-002 | Schema enforcement | JSON Schema 2019-09 + Aonex custom vocabulary (`tier`, `confidence_required`); validation at approval | Amazon SP-API Product Type Definitions precedent; JSON Schema is the lingua franca |
| ADR-AON-003 | Category maturity | Three tiers: Authoritative (hand-curated, strict), Inferred (LLM-extracted, permissive), Promoted (graduation pipeline) | "Any product, accurately" requires this; alternative is years of manual ontology authoring |
| ADR-AON-004 | Taxonomy | Hybrid: Google Product Taxonomy paths, schemas authored only at chosen leaves | Public, comprehensive, free, matches Google Merchant Center wording; selective depth avoids overcommitment |
| ADR-AON-005 | Seed schema generation | LLM-draft ~150 schemas from Google Product Taxonomy + 3–5 example URLs per category; hand-refine top 30 | Cheaper than hand-authoring (~$20–50 LLM cost); demo never says "unsupported category" |
| ADR-AON-006 | Ingestion contract | Single `IngestionAdapter` interface; one envelope shape; one downstream pipeline | Eliminates 3-personality drift; lane-specific complexity contained inside adapter |
| ADR-AON-007 | Anti-bot / proxies / CAPTCHA | **Buy** (Bright Data Web Unlocker primary, ScrapingBee mid-tier, CapSolver for CAPTCHAs) | Research brief verdict; in-house is a perpetual SRE drain; cost scales linearly |
| ADR-AON-008 | LLM extraction | **Groq** as primary provider (via existing `OpenAIProvider` + `baseUrl=https://api.groq.com/openai/v1`). Primary gap-fill model: Llama 3.3 70B Versatile (~$0.59 input / $0.79 output per 1M tokens). Cheap classification: Llama 3.1 8B Instant (~$0.05/$0.08 per 1M). Vision tier-3 (later phase): Llama 3.2 90B Vision. Structured output via JSON mode; tool use where the model supports it; prompt caching where Groq supports it | Already provisioned in current `llm-extractor`; significantly cheaper than Anthropic / OpenAI at comparable extraction quality for product pages; ~10× throughput on inference latency, which materially shifts the static-fetch→browser-fallback economics |
| ADR-AON-009 | Per-site parsers | Build for top 10 retailers (Shopify exists; add Amazon, eBay, Walmart, Decathlon, Best Buy, IKEA, AliExpress, WooCommerce-generic, Magento-generic); generic LLM fallback for the long tail | Mature systems run 50–300 parsers; we start with the tier-1 set + extensible registry |
| ADR-AON-010 | Multi-tenancy schema variance | Global Tier 1 schema + additive tenant overlay via JSON Schema `allOf`; tenants may strengthen required and narrow enums; cannot weaken or remove core required fields | Pattern from Salsify Templates + AWS PostgreSQL RLS guidance; preserves cross-tenant queryability |
| ADR-AON-011 | Confidence calibration | Per-(extractor × category × source-type) isotonic regression calibrator fit on golden set; per-(domain × field) Beta-binomial prior updated from reviewer corrections | LLM raw confidences are uncalibrated (ECE 0.12–0.40); calibration is cheap with ≥100 examples |
| ADR-AON-012 | Rollout discipline | Shadow mode for every new parser / prompt / LLM model ≥ 7 days; auto-rollback on golden-set regression > 1pp absolute | Standard pattern; LLM-rescue silent degradation is the dominant failure mode without this |
| ADR-AON-013 | Channel projection | Deferred to a later phase; canonical model designed to be projectable (per HLD §16) but compiler not built now | Out of immediate scope; canonical schema must not encode marketplace-specific shapes |

---

## 4. The canonical model

### 4.1 Four layers (HLD §8.1)

```
products                          ─── stable identity (one row, never moves)
  ├─ product_versions             ─── immutable approved snapshots
  │    ├─ Layer 1 — typed columns ─── universal core every product has
  │    └─ Layer 3 — attributes_json ── category-specific, schema-validated
  ├─ product_variants             ─── Layer 2 — SKU-level variation
  │    └─ product_variant_versions
  ├─ product_identities           ─── GTIN/MPN/ASIN/etc. for dedup
  └─ marketplace_listings         ─── Layer 4 — external IDs (DEFERRED)

Reference data (data, not code):
  category_schemas                ─── per-category JSON Schema + required attrs + tier
  attribute_definitions           ─── canonical attribute keys + types + units
  attribute_synonyms              ─── "shade" → "color", per-locale, per-marketplace
  attribute_mappings              ─── deterministic per-marketplace channel mappings
  mapping_overrides               ─── per-tenant + per-domain corrections
  attribute_embeddings            ─── pgvector for fuzzy candidate retrieval
```

### 4.2 The Universal Core (Layer 1)

Typed columns on `product_versions`, present for every product regardless of category:

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `product_id` | `uuid` FK | parent identity |
| `tenant_id` | `uuid` | RLS lead column |
| `merchant_id` | `uuid` | |
| `proposed_diff_id` | `uuid` FK NOT NULL | every version traces to an approved diff |
| `version_number` | `integer` | monotonic per product |
| `title` | `varchar(500)` NOT NULL | |
| `brand` | `varchar(200)` | |
| `gtin` | `varchar(30)` | normalized GTIN-13 |
| `gtin_type` | `varchar(10)` | GTIN-8, GTIN-12, GTIN-13, GTIN-14, ISBN |
| `model_number` | `varchar(100)` | display model |
| `manufacturer_part_number` | `varchar(100)` | **NEW** — was missing |
| `description` | `text` | |
| `base_price` | `numeric(12,4)` | |
| `currency` | `char(3)` | ISO 4217 |
| `weight_grams` | `numeric(12,3)` | **NEW** — was missing |
| `dimensions_cm` | `jsonb` | **NEW** — `{l, w, h}` in centimetres |
| `images` | `jsonb` | array of `{url, altText?}` |
| `category_path` | `varchar(300)` FK → `category_schemas.category_path` | |
| `category_schema_version` | `varchar(50)` | **NEW** — pinned at approval, never updated |
| `category_confidence` | `numeric(5,4)` | **NEW** — detector confidence |
| `attributes_json` | `jsonb` NOT NULL DEFAULT '{}' | **NEW** — Layer 3 |
| `merchant_extensions_json` | `jsonb` | per-tenant private fields (kept; no longer abused for attributes) |
| `confidence_score` | `numeric(5,4)` NOT NULL | overall product score |
| `evidence_summary` | `jsonb` | **NEW** — extraction methods, source URLs, cost, model, calibration version |
| `created_at` | `timestamptz` | |

Immutability remains enforced by Postgres trigger (already present; verify covers new columns).

### 4.3 Layer 3 — `attributes_json` + JSON Schema validation

Every category-specific attribute lives in `attributes_json` as a flat key:value map. Keys are canonical attribute codes from `attribute_definitions` (never raw source names — those are mapped by the Semantic Mapper). Values are typed per the attribute's `data_type` and normalized to `canonical_unit`.

`category_schemas.json_schema` is a JSON Schema 2019-09 document with optional Aonex custom keywords (`tier`, `confidence_required`). At approval time, the validator runs `attributes_json` against the schema. Outcomes:

| Tier 1 validator result | Action |
|-------------------------|--------|
| All required present, types/units valid | Approve; record passes |
| Missing required attribute | Open `review_task` type `missing_required_attribute`; do NOT auto-approve |
| Type / unit mismatch | Open `review_task` type `unit_conflict` |
| Enum value outside allowed list | Open `review_task` type `low_confidence_mapping` with candidate enum |
| Unknown extra attribute keys | Accept; allow; promotion job will consider them |

| Tier 2 validator result | Action |
|-------------------------|--------|
| Layer 1 core present (title, brand, base_price); confidence ≥ 0.85 single-source OR ≥ 0.75 with multi-source agreement | Auto-approve |
| Layer 1 core present, confidence below the band above | Open `review_task` type `low_confidence_mapping` |
| Missing Layer 1 core | Open `review_task` type `missing_required_attribute` (against Layer 1 only) |
| Any Layer 3 attrs | Stored verbatim; no validation |

### 4.4 Tiered Schema Maturity

`category_schemas.tier` enum: `authoritative` (1) | `inferred` (2) | `promoted_draft` (intermediate state in the promotion pipeline).

**Tier 1 — Authoritative.** Hand-curated or hand-refined LLM draft. Full `required_attributes`, `optional_attributes`, `variant_options`, `json_schema`, `marketplace_mappings`. Strict validator. Auto-approve threshold ≥ 0.90.

**Tier 2 — Inferred.** Created by LLM category detection on the fly when an ingested product lands in a `category_path` with no formal schema. Empty `required_attributes` (only Layer 1 core required). Permissive validator. Auto-approve threshold ≥ 0.75 with two-source agreement or 0.85 single-source.

**Promotion pipeline.** Nightly cron `schema-promotion-scan`:
1. Scan `product_versions` where `category_schema_version IS NULL` (Tier 2)
2. Group by inferred `category_path`
3. For each group, count products (require ≥ 50) and find attribute keys present in ≥ 80% of them
4. If a category has ≥ 50 products and ≥ 8 consistent attribute keys, generate a draft schema (LLM-assisted), insert into `category_schemas` with `tier='promoted_draft'`
5. Queue admin review (UI lists drafts with sample products)
6. On admin approval, flip `tier='authoritative'`, run a backfill job that re-validates existing Tier 2 products in that category against the new schema and opens `review_task` rows for any newly-failing required attributes

### 4.5 Taxonomy: Hybrid Google Product Taxonomy

Adopt Google Product Taxonomy's slash-delimited path structure (`electronics/televisions`, `outdoor/camping/tents`, `luggage_bags/umbrellas`). Seed ~150 categories at launch with LLM-drafted schemas; hand-refine the top ~30 most-likely-hit categories. Other GPT paths exist (the full ~5000-node tree is present in `category_schemas` as Tier 2 placeholders or absent — inferred categories create rows on demand).

Category codes are immutable; localized display names live in a sidecar table `category_labels(category_path, locale, display_name)`.

### 4.6 Migrations required

```
M-001  product_versions: ADD COLUMN attributes_json jsonb NOT NULL DEFAULT '{}'
M-002  product_versions: ADD COLUMN weight_grams numeric(12,3)
M-003  product_versions: ADD COLUMN dimensions_cm jsonb
M-004  product_versions: ADD COLUMN manufacturer_part_number varchar(100)
M-005  product_versions: ADD COLUMN category_schema_version varchar(50)
M-006  product_versions: ADD COLUMN category_confidence numeric(5,4)
M-007  product_versions: ADD COLUMN evidence_summary jsonb
M-008  product_versions: CREATE INDEX idx_product_versions_attrs_gin USING GIN (attributes_json jsonb_path_ops)
M-009  category_schemas: ADD COLUMN tier varchar(20) NOT NULL DEFAULT 'authoritative'
M-010  category_schemas: ADD COLUMN parent_path varchar(300)
M-011  category_schemas: ADD COLUMN display_name varchar(200) NOT NULL DEFAULT ''
M-012  category_schemas: ADD COLUMN active boolean NOT NULL DEFAULT true
M-013  CREATE TABLE category_labels (category_path, locale, display_name)
M-014  attribute_embeddings: enable pgvector; ALTER COLUMN embedding TYPE vector(1536); CREATE INDEX ivfflat (embedding vector_cosine_ops)
M-015  CREATE TABLE category_attribute_promotion_candidates (
         id, category_path, attribute_key, products_with_key, total_products,
         consistency_ratio, first_seen_at, last_seen_at, status enum('candidate'|'proposed'|'approved'|'rejected'))
M-016  source_artifacts: ALTER source_type to include 'link_url'; ALTER source_marketplace enum
M-017  Backfill: migrate merchant_extensions_json.attributes → attributes_json
       for existing product_versions where applicable
M-018  Backfill: populate evidence_summary from extracted_facts joins
M-019  Verify immutability trigger covers all new columns
M-020  Apply Postgres RLS to source_artifacts, product_versions, audit_events
       (lead index column = tenant_id)
M-021  CREATE TABLE tenant_category_overlays (
         tenant_id, category_path, schema_version, overlay_json,
         created_at, updated_at,
         PRIMARY KEY (tenant_id, category_path, schema_version))
       — additive JSON Schema overlay composed via allOf at validator time (see §11.2)
```

Expand-contract discipline applies (the 47-services-broken pattern). New columns are nullable on add; backfill in chunks; tighten constraints after backfill completes.

---

## 5. The ingestion spine

### 5.1 `IngestionAdapter` contract

```typescript
// packages/ingestion/types/src/adapter.ts (new)

export type IngestionLane = "link" | "csv" | "nango";

export interface IngestionAdapter {
  readonly lane: IngestionLane;

  /**
   * Yield IngestionEnvelopes one at a time.
   * Each envelope is one logical "product candidate" to ingest.
   * Adapter handles its own lane-specific fetching/parsing/pagination.
   * Adapter is responsible for emitting *raw* data only; downstream
   * pipeline owns persistence, mapping, validation, scoring, diffing.
   */
  normalize(input: AdapterInput): AsyncIterable<IngestionEnvelope>;
}

export interface IngestionEnvelope {
  /** Stable external ID this envelope represents (URL for link, row-id for CSV, marketplace SKU for Nango). */
  sourceExternalId: string;
  /** Lane-specific source type for source_artifacts. */
  sourceType: "link_url" | "templated_csv" | "marketplace_connector";
  /** Marketplace enum when applicable (Nango lane); null for link/CSV. */
  sourceMarketplace: Marketplace | null;
  /** The raw record (HTML snippet + structured blocks for link, parsed CSV row, raw Nango payload). */
  rawData: Record<string, unknown>;
  /** SHA-256 hex of rawData canonical-stringified — drives staging dedup. */
  checksum: string;
  /** For row-level CSV artifacts that descend from a file-level artifact. */
  parentArtifactId?: ArtifactId;
  /** Adapter-supplied hints to the extraction pipeline (categoryHint, regionHint, etc.). */
  extractionHints?: ExtractionHints;
  /** Object-storage URI for large raw evidence (full HTML, CSV file). */
  storageUri?: string;
}

export interface ExtractionHints {
  categoryHint?: string;
  regionHint?: string;
  localeHint?: string;
  perSiteParserHint?: string;
}
```

### 5.2 Pipeline stages

The spine (single worker per stage; queues per HLD §18):

```
ingestion.classify          → ingestion.extract           → ingestion.map
  (artifact persisted,         (per-lane Field             (semantic mapper:
   source type confirmed)       Extractor produces           raw_key → canonical_key)
                                ExtractedFactSet)
                                                            ↓
                                                          ingestion.validate
                                                            (per-category JSON Schema;
                                                             missing required → review_task)
                                                            ↓
                                                          ingestion.score
                                                            (policy engine 40/20/25/15;
                                                             calibrated per category)
                                                            ↓
                                                          catalog.diff
                                                            (proposed_diff;
                                                             status auto_approved | open)
                                                            ↓
                                                          catalog.approve
                                                            (applyApprovedDiff;
                                                             product_version created;
                                                             attributes_json validated again)
```

Every stage emits `audit_events`. Every job is idempotent on `(artifact_id, stage, extractor_version, mapper_version, policy_version_id)`.

### 5.3 Adapter implementations

| Adapter | Triggered by | Internals (high-level) |
|---------|--------------|------------------------|
| `LinkAdapter` | `POST /v1/ingestions/link` (single) and `/batch` (≤20) | Layers A–H (§6); produces one envelope per URL |
| `CsvAdapter` | `POST /v1/ingestions/csv` (multipart upload) | Streaming parse of templated CSV; persists file artifact + per-row envelope |
| `NangoAdapter` | **Not delivered in this phase.** Nango lane stays on its existing path (see §2.1.1). The adapter shape is documented for the Nango engineer to adopt later if/when convenient. | n/a — preserved as-is |

The existing link-extract logic (`apps/worker/src/processors/link-extract.processor.ts`, `services/link-catalog-pipeline.ts`) is refactored: lane-specific bits move into `LinkAdapter`, pipeline-common bits become the shared spine workers. The 465-line processor shrinks to a ~50-line orchestrator.

---

## 6. Extraction pack (LinkAdapter internals)

### 6.1 Layer A — Structured-data parsers

Already present (and recently strengthened — JSON-LD depth/breadth fixes, NEXT_DATA breadth, value-contradiction detector). To add:

| Parser | Status | Notes |
|--------|--------|-------|
| JSON-LD | Exists; **add cross-validator** vs DOM/OG (15–30% of JSON-LD is invalid per WebDataCommons + Digital Chakra studies) | conflicts → low confidence |
| Microdata | Exists | |
| RDFa | New | Less common but worth the day-of-work |
| OpenGraph | Exists | |
| `__NEXT_DATA__` | Exists | |
| `__NUXT__` | **New** | Nuxt-rendered SPAs |
| `window.__INITIAL_STATE__` | **New** | Vue/React custom |
| Shopify probe | Exists; **extend with `/products.json`** | Every Shopify store exposes this by default; richest single signal |
| Magento `x-magento-init` | **New** | Adobe Commerce |
| WooCommerce `wc-product-data` | **New** | WP/Woo |
| Algolia inline index | **New** | Headless stores often leak full catalog |
| Schema.org BreadcrumbList | **New** | Best signal for `category_path` when Product schema is absent |

Each parser emits `ExtractedFact[]` with `source_pointer` (JSONPath / CSS / XPath as appropriate), `extraction_method`, and a method-prior confidence.

### 6.2 Layer B — DOM heuristics

When structured data is absent or contradicted, fall to DOM heuristics:

- **Price** — currency-symbol regex + `itemprop="price"` + class-name patterns (`/price|amount|cost/i`); pick smallest numeric in visible product area; reconcile candidates
- **Image gallery** — start from `og:image`; candidate set = all `<img>` + `<source srcset>` in the H1's container; filter by aspect ratio (0.5–2.5) and min size (>400px); dedupe by URL stem
- **Breadcrumb → category** — Schema.org `BreadcrumbList` first; fallback any `<nav>`/`<ol>` chain ending near H1
- **Spec table** — `<table>` with `<th>/<td>` is easy; `<dl>/<dt>/<dd>` and div-soup specs → LLM (Layer E)
- **Variant selector** — `<select>` near H1, radio groups with `data-variant`, `aria-label="Color"`; Shopify `theme.product.variants` takes precedence
- **Title** — H1 > `og:title` > JSON-LD title (priority order)
- **Description** — longest text block near product area, content-type filtered

### 6.3 Layer C — Browser rendering fallback

Static fetch first. Escalation signal triggers Playwright pool:

- Body smaller than ~30KB
- `<noscript>` with "enable JS" message
- Initial HTML's main content container empty
- No `__NEXT_DATA__` / `__NUXT__` AND no JSON-LD AND OG present (likely client-rendered with no SSR)
- Coverage check after Layer A+B returns < 50% of required Layer 1 core fields

Playwright config:
- `domcontentloaded` + selector-based wait on known product DOM hooks
- Resource blocking for images/CSS during fetch (re-enable for screenshots when vision tier kicks in)
- 5–50 concurrent workers initially; metric-driven scale

### 6.4 Layer D — Anti-bot (vendor, confirmed buy)

Escalation ladder per URL:

1. Static fetch (free)
2. Playwright in-process (compute cost only)
3. Vendor unlock (paid)

Recommended vendor: **Bright Data Web Unlocker** primary (~$1.30–1.50 per 1K successful, highest reliability across Cloudflare/Datadome/Akamai/Kasada). Secondary: ScrapingBee (mid-difficulty). CAPTCHA: CapSolver ($0.50–1.20 per 1K).

Cost-ceiling per URL configurable; trips circuit breaker per domain when ratio of vendor-cost / extraction-attempts exceeds threshold.

### 6.5 Layer E — LLM gap-fill

Triggered when coverage (post Layer A+B+C) misses ≥ 1 required Layer 1 field or any required Tier 1 Layer 3 field.

- **Provider:** Groq (already used by `packages/ingestion/llm-extractor`). The existing `OpenAIProvider` works via `baseUrl=https://api.groq.com/openai/v1`; the only change is the env-configured model name and a pricing-table update in `providers/openai.ts:11-17`.
- **Primary model:** Llama 3.3 70B Versatile for gap-fill (best quality/cost balance on Groq's lineup; ~$0.59 input / $0.79 output per 1M tokens; per-page cost ~$0.0005–0.001)
- **Classification model:** Llama 3.1 8B Instant for category detection where rule-based confidence is low (cheaper, faster; ~$0.05/$0.08 per 1M)
- **Mode:** JSON mode (`response_format: {type: "json_object"}` — already supported in the existing provider); for tool use, depends on which Groq models expose tool-calling — we'll detect at runtime and degrade to JSON mode if not
- **Prompt caching:** Groq's caching support is more limited than Anthropic's; rely on response caching at the application layer (keyed on URL + cleaned-text hash) for repeated extraction of the same page
- **Scope:** send the relevant DOM slice (price area, spec table, variant selector) + the structured-data context already extracted; ask only for missing fields
- **Output:** `ExtractedFact[]` with `extraction_method: "llm_gap_fill"` and a confidence that is *not* the model's raw verbalized confidence (those are uncalibrated) but a method-prior modulated by per-domain reliability

### 6.6 Layer F — Vision LLM tier-3

Reserved for image-spec verticals. Triggered when:

- Apparel size charts / fit guides rendered as images
- Spec sheets rendered as JPG/PNG (common on industrial parts, some Asian retailers)
- Variant swatches with no `alt` text and color encoded only via CSS background
- Anti-scraping where price is image-rendered

Model: Groq Llama 3.2 90B Vision (~$0.90/$0.90 per 1M tokens; per-page cost ~$0.003–0.005 with screenshot). Reserve for known verticals + explicit signal (apparel size charts, electronics with spec images, image-rendered prices). Vision is *not* a default fallback; it is a tier-3 escalation gated by per-vertical heuristics.

### 6.7 Layer G — Per-site parser registry

Parser registry shape (extends existing `packages/ingestion/field-extractor/src/registry.ts`):

```typescript
interface PerSiteParser {
  domains: string[];                    // hostnames this parser handles
  priority: number;                     // higher wins when multiple match
  extract(html: string, url: string): Promise<ExtractedFact[]>;
  fingerprint: string;                  // version for selector health tracking
}
```

Launch set:

- Shopify (exists — productify)
- Amazon (`amazon.com`, regional TLDs)
- eBay
- Walmart
- Decathlon
- Best Buy
- IKEA
- AliExpress
- WooCommerce-generic (signal: `wc-product-data` present)
- Magento-generic (signal: `x-magento-init` present)

Selector-health monitoring: per-selector firing counter emitted as `selector.fired{selector_id, domain, success}`; ladder-fallback rung logging (signal: "we got this from LLM rung when Amazon parser was supposed to fire" → parser-broken alert).

### 6.8 Layer H — Multi-source verification by GTIN

When a newly extracted product has a GTIN that already exists in `product_identities`, the deduplicator does NOT create a new product. Instead, the new extracted facts produce a `proposed_diff` against the existing product, with cross-source attestation.

Scoring formula (per research brief §7):

```
identity_score = 0.40 * gtin_match
                + 0.20 * brand_match
                + 0.25 * title_similarity (Jaro-Winkler)
                + 0.15 * spec_overlap
```

Conflict resolution policy:
- Field-level voting, not record-level
- Manufacturer site > authorized retailer > marketplace seller (primary-source heuristic)
- Tiebreaker: structured-data quality score + recency
- Conflicting GTIN across sources for same product → `value_conflict` review task (never silent merge)

Existing `sourceAlternatives` field on `extracted_facts` (recent commit 4d51f61) is the storage for cross-source loser values; extend to drive cross-source-conflict detector.

---

## 7. CSV lane

HLD §11.3 template only. Loose CSV header mapping deliberately deferred.

### 7.1 Template (locked)

```csv
product_handle,parent_sku,variant_sku,title,brand,gtin,model_number,manufacturer_part_number,
category_path,description,base_price,currency,weight_grams,length_cm,width_cm,height_cm,
inventory_quantity,image_url,
option_1_name,option_1_value,option_2_name,option_2_value,option_3_name,option_3_value,
attributes.screen_size,attributes.resolution,attributes.display_type,
attributes.ram_gb,attributes.storage_gb,attributes.os,
attributes.material,attributes.fit,attributes.size,attributes.color,
merchant_extensions.notes
```

`attributes.*` columns are open-ended — any column with that prefix gets parsed as a Layer 3 attribute. The mapper validates against the Layer 1 category schema (via `category_path`) after parsing.

### 7.2 Flow

1. `POST /v1/ingestions/csv` (multipart): merchant_id, file, optional category_hint
2. API persists raw file to S3, creates file-level `source_artifact`, returns `202 Accepted` with `ingestion_id`
3. `CsvAdapter.normalize` streams the file (papaparse-style streaming for files up to 10K rows), validates header exactness, type-checks each row
4. Per row:
   - Malformed (header mismatch, type fail) → `source_artifacts.processing_errors` with row number, no envelope produced
   - Good → emit `IngestionEnvelope` with `parent_artifact_id` pointing at the file artifact
5. Downstream spine handles each row identically to link-lane envelopes

### 7.3 Constraints

- Max file size: 100MB (configurable)
- Max rows per file: 100K (chunked into multiple ingestion runs above this)
- Header must match exactly; column order can vary
- Empty `attributes.*` cells are tolerated (missing); empty required Layer 1 cells reject the row
- `category_path` either matches a category schema or falls to Tier 2 inferred handling

---

## 8. Catalog + versioning

Mostly already in place. Changes required:

| Component | Status | Change |
|-----------|--------|--------|
| `products` | Exists | None |
| `product_identities` | Exists | None |
| `product_versions` | Exists | Add 7 columns (§4.6 migrations) |
| `product_variants` / `product_variant_versions` | Exists | None |
| `applyApprovedDiff` (`packages/catalog/catalog-service/src/index.ts`) | Exists | **Rewrite**: stop stuffing `attributes` and `evidence` into `merchant_extensions_json`; populate `attributes_json` and `evidence_summary` properly; run JSON Schema validation against the category schema before insert; pin `category_schema_version` |
| Immutability trigger | Exists | Verify covers new columns |
| Soft delete | Exists | None |
| Defensive rehydrate-missing-core | Exists | Keep |
| `proposed_diffs` / `proposed_diff_fields` | Exists | None for shape; expand `diff_payload` schema to include `attributes` as a typed key (not stuffed) |

---

## 9. Review layer (Anomaly Lab)

Mostly already exists (`packages/anomaly-lab/*`, `apps/api/src/routes/review.ts`, `apps/api/src/services/review-resolution.ts`). Gaps to close:

- New task type: `missing_required_attribute` — emitted by the validator stage when a Tier 1 product is missing a required attribute. Reviewer fills the value (or marks not-applicable, or rejects).
- New task type: `value_conflict` — emitted by multi-source verification when two sources disagree on a high-weight field (price, GTIN, brand). Reviewer picks the source.
- New task type: `category_schema_drift` — emitted when a previously-approved product no longer satisfies a newer schema version (Tier 3 promotion backfill).
- Reviewer UI: diff-only display per the PIM research recommendation (never the whole record; combats fatigue).
- Cluster resolve already supports bulk; extend to handle new task types.
- Mapping override creation on edit-and-approve flows already implemented.

---

## 10. Promotion layer

New, runs as nightly cron `schema-promotion-scan`.

### 10.1 Algorithm

```
For each (tenant_id, category_path) where category_schemas.tier = 'inferred'
  OR (category_schema_version IS NULL across products in that path):
  products ← SELECT * FROM product_versions WHERE category_path = $1 AND tenant_id = $2
  IF count(products) < 50: skip
  attribute_keys ← attribute keys present in >= 80% of products
  IF count(attribute_keys) < 8: skip
  attribute_types ← infer JSON Schema type per key from observed values
  draft_schema ← LLM-generate JSON Schema using (category_path, attribute_keys, attribute_types,
                    3-5 sample products) as prompt context
  Insert into category_schemas with tier='promoted_draft', schema_version=now-stamped
  Insert into admin promotion queue
```

### 10.2 Admin approval flow

- Admin UI lists draft schemas with sample products and consistency stats
- Admin approves → `tier='authoritative'`; trigger backfill
- Admin rejects → `tier='inferred'` reverts; reasoning logged
- Backfill: for each existing product in this category, run the new schema validator; missing required attrs → `review_task` `category_schema_drift` (does NOT invalidate existing approved version; new version only on reviewer action)

### 10.3 Synonym promotion

Existing `override-promotion-scan` job (in `apps/worker/src/jobs/`) — extend:

- When a `mapping_override` accumulates ≥ 10 uses across ≥ 3 tenants, propose as global `attribute_synonym`
- Spam guard: tenant trust score must exceed threshold before counted
- Per-tenant overlay: tenants can keep their own synonyms private if they decline global promotion

---

## 11. Storage + multi-tenancy

### 11.1 Tenant isolation

- `tenant_id` on every business table (verified across schema)
- Postgres RLS on `products`, `product_versions`, `source_artifacts`, `extracted_fact_sets`, `extracted_facts`, `proposed_diffs`, `review_tasks`, `audit_events`
- RLS policy: lead index column = `tenant_id`; tests confirm < 1ms policy evaluation at 50M-row scale (per AWS/Thenile benchmarks)
- Application middleware sets `app.tenant_id` per request and per worker job

### 11.2 Per-tenant schema variance

Global Tier 1 schemas are authoritative. A tenant may declare a `tenant_overlay` per category that:

- Lifts an attribute from `optional` to `required`
- Narrows an `enum_values` list
- Adds tenant-private attribute keys

Cannot remove or weaken core required attrs (preserves cross-tenant queryability).

JSON Schema composition via `allOf`:

```jsonc
// effective schema for tenant X in category electronics/mobile_phones
{
  "allOf": [
    { "$ref": "category_schemas/electronics_mobile_phones/v1" },
    { "$ref": "tenant_overlays/tenant_X/electronics_mobile_phones" }
  ]
}
```

New table `tenant_category_overlays(tenant_id, category_path, schema_version, overlay_json)`.

### 11.3 Index strategy

- Btree on every `tenant_id` lead column
- GIN(`jsonb_path_ops`) on `attributes_json` and `variant_axes`
- Expression indexes on the 5–10 hottest attribute keys per Tier 1 category (built after observation; not premature)
- pgvector ivfflat on `attribute_embeddings.embedding`
- `audit_events` time-partitioned by month (deferred until volume warrants)

### 11.4 Raw evidence storage

- `source_artifacts.raw_data` for parsed JSON / CSV row (small, stored inline)
- `source_artifacts.storage_uri` for full HTML / CSV files
- **Storage layer (decided 2026-05-16): MinIO in docker-compose for dev/staging; S3-compatible SDK (`@aws-sdk/client-s3`) used with `OBJECT_STORE_ENDPOINT` env var so production can swap to AWS S3 / Cloudflare R2 / Backblaze B2 without code change.** Bucket: `aonex-source-artifacts`. Region configurable.
- `htmlSnippet` capped at 10KB inline (in `raw_data.htmlSnippet`)
- Retention: audit events forever, raw HTML rotate at 90 days, cost ledger forever, extracted_facts forever
- Env vars (added to `.env.example`): `OBJECT_STORE_ENDPOINT`, `OBJECT_STORE_BUCKET`, `OBJECT_STORE_ACCESS_KEY_ID`, `OBJECT_STORE_SECRET_ACCESS_KEY`, `OBJECT_STORE_REGION`

---

## 12. Operations

### 12.1 Queues (BullMQ)

| Queue | Job names | Concurrency | Retry |
|-------|-----------|-------------|-------|
| `ingestion.classify` | classify_source | 10 | 3, exp backoff 5s |
| `ingestion.extract` | extract_link, extract_csv_row, extract_marketplace_record | 20 | 3, DLQ on bug |
| `ingestion.map` | semantic_map | 20 | 3, review task on failure |
| `ingestion.validate` | schema_validate | 20 | 3 |
| `ingestion.score` | policy_score | 20 | 3 |
| `catalog.diff` | create_diff | 10 | 3 |
| `catalog.approval` | apply_auto_approval | 10 | 5, idempotent |
| `audit` | write_audit_event | 30 | must not drop; fallback to durable queue |
| `nango.sync` | nango_sync_event | 5 | 5, idempotent |
| `nango.drain` | drain_records | 5 | provider-aware backoff |
| `link.extract` | link_extract (legacy; folded into ingestion.extract) | — | — |

All payloads carry `tenant_id, merchant_id, request_id, trace_id, job_version, idempotency_key`.

### 12.2 Crons

| Cron | Schedule | Purpose |
|------|----------|---------|
| `domain-profile-refresh` | nightly | recompute per-domain reliability (exists) |
| `failure-pattern-rollup` | nightly | aggregate extraction_failures (exists) |
| `override-promotion-scan` | nightly | propose global synonyms (exists, extend) |
| `schema-promotion-scan` | nightly | propose Tier 2 → Tier 1 schemas (new) |
| `selector-health-scan` | hourly | per-selector firing counters, alert on null spikes (new) |
| `cost-budget-check` | hourly | per-tenant budget caps, alerts (new) |
| `calibration-refit` | weekly | refit isotonic regression calibrators per (extractor × category × source-type) on golden set (new) |
| `canary-poll` | hourly | poll N canary URLs per top-10 retailer, compare against frozen expected (new) |

### 12.3 Cost ledger

`cost_ledger` table (exists in HLD §20; add if missing):

```
(id, tenant_id, merchant_id, cost_type, entity_type, entity_id,
 quantity, unit, estimated_cost_usd, vendor, metadata, created_at)
```

Emitted from: LLM calls (tokens), vendor anti-bot calls (per success), browser-fetch (compute proxy), object storage (bytes). Aggregations expose `cost_per_successful_extraction` per `(lane, tier, tenant, vendor, model)`.

Per-tenant monthly budget caps with hard-stop circuit breaker on exhaustion. Soft-warning at 80%.

### 12.4 Observability

- OpenTelemetry trace context propagated from API → queue → worker → external vendor → DB
- Required tags on every span: `tenant_id, merchant_id, request_id, artifact_id, extraction_run_id, fact_set_id, product_id, product_version_id, proposed_diff_id, lane, tier, extractor_version, mapper_version, policy_version`
- High-cardinality event store (Honeycomb-style or self-hosted ClickHouse) for raw events
- Prometheus/Datadog for aggregate SLOs without per-tenant tagging except top-50 tenants

### 12.5 SLOs (initial targets)

| Path | Target |
|------|--------|
| Static-fetch link extraction P95 | < 3s |
| Browser-fetch link extraction P95 | < 12s |
| Anti-bot-vendor link extraction P95 | < 25s |
| CSV file → first row validation P95 | < 2 min (≤ 10K rows) |
| Marketplace webhook → source_artifact persisted P95 | < 5 min |
| Auto-approved link → product_version P95 | < 30s on structured-rich; < 5 min on browser+LLM path |
| Review task list load P95 | < 1s for first page |
| Per-easy-domain extraction success rate (Amazon/Shopify-class) | ≥ 95% |
| Per-hard-domain extraction success rate | ≥ 50% with vendor unlock; tracked per-domain |
| End-to-end pipeline success rate by lane | ≥ 90% |
| External write attempts with audit event | 100% (zero gap policy) |
| Duplicate product_versions from retry | 0 |

### 12.6 Runbooks

- Replay a failed ingestion artifact (HLD §27.1; verify still works after spine refactor)
- Provider auth failure (HLD §27.2)
- Vendor API outage (Bright Data / ScrapingBee / LLM provider down) — circuit breaker, failover to secondary vendor, alert
- Bad auto-approval discovered — corrective diff workflow; consider new policy version
- Anti-bot escalation surge on a domain — auto-route through Web Unlocker, page on-call if cost-per-success doubles
- Schema promotion backfill stalled — manual intervention path

---

## 13. Security

### 13.1 Multi-tenant isolation

- RLS enforced (§11.1)
- Adversarial tenant isolation test in CI: tenant A cannot read tenant B's products under any query

### 13.2 Credential handling

- Provider tokens via Nango — never logged, never returned to frontend
- Vendor API keys (Bright Data, ScrapingBee, LLM providers) in credential vault (e.g. AWS Secrets Manager / HashiCorp Vault); referenced by ID
- Workers receive short-lived internal tokens, not provider credentials

### 13.3 Prompt-injection defense (LLM extraction)

- Untrusted HTML / page content treated as data, never as instructions
- LLM output: always validated against JSON Schema; rejected output triggers review task
- No agent loops; LLM cannot select or trigger tool calls; cannot write directly to catalog
- Separation: extract → propose → approve; no path from raw LLM output to canonical write without policy/reviewer approval
- LLM prompts are static + cached; user-controllable inputs (URLs, category hints) are sandbox-quoted

### 13.4 RBAC

| Role | Allowed |
|------|---------|
| Admin | Manage connections, approve review tasks, manual sync (deferred), manage categories, approve promoted schemas, view audit |
| Operator | Upload CSV, trigger sync, approve normal review tasks |
| Reviewer | Resolve Anomaly Lab tasks; cannot manage connectors or global schema |
| Analyst | Read catalog, ingestion status, analytics; no writes |
| Auditor | Read audit logs and evidence; no catalog mutation |

---

## 14. Quality

### 14.1 Golden datasets

| Dataset | Minimum size before launch |
|---------|---------------------------|
| Shopify records | 100 products: 30 apparel, 30 electronics, 20 home, 20 mixed; include variants and metafields |
| Amazon records | 50 products (when per-site parser is ready); include Product Type Definition validation fixtures |
| CSV rows | 500 rows across 10 categories; include 50 deliberately malformed |
| Decathlon records | 50 products across tents, hiking_boots, running_shoes |
| Generic / long-tail | 100 products from random retailers (WP, WooCommerce, Magento, custom) |
| Duplicate cases | 100 pairs: GTIN match, brand+MPN, title fuzzy, false positives |
| Review tasks | 50 tasks covering every task type |

Sized per the research brief's recommendation (100–200 per category × source-type triple for composite-score stability).

### 14.2 Per-field accuracy metrics

| Field class | Metric |
|-------------|--------|
| GTIN, MPN, ASIN | Exact match + checksum validation |
| Price / currency | Exact match + unit-aware tolerance ±1% |
| Quantitative (dimensions, weight, capacity) | Numeric proximity (relative error) + unit-normalization correctness |
| Title, brand | Normalized fuzzy match (Jaro-Winkler, token-set ratio) ≥ 0.85 |
| Description | LLM-judge semantic match against rubric; ROUGE-L for paraphrase; hallucination rate (unique-claim precision) |
| Enums (color, material, size, fit) | Synonym-resolved exact match; top-3 for ambiguous |
| Structured (variants, attributes_json) | Per-key F1; per-value F1; schema validity rate |
| Images | URL liveness + perceptual hash dedup |

### 14.3 Acceptance targets

| Area | Metric | Target |
|------|--------|--------|
| Field extraction | Required-field exact match on templated CSV | ≥ 95% |
| Mapping | Top-1 canonical accuracy on known marketplace fields | ≥ 92% |
| Mapping | Top-3 candidate recall on ambiguous fields | ≥ 98% |
| Category | Assignment accuracy on Tier 1 categories | ≥ 90% rule-based; > 95% with LLM ensemble |
| Dedup | Bad merge rate | 0 critical cases in golden set |
| Idempotency | Duplicate product_version from retry | 0 |
| Audit | External write without audit event | 0 |
| Validation | Local validation catches known invalid payloads | 100% |

### 14.4 Confidence calibration

- Per (extractor_version × category × source_type), maintain an isotonic regression calibrator fit on a 200-example calibration set; refit weekly via `calibration-refit` cron
- Per (domain × field), maintain a Beta-binomial conjugate prior updated from reviewer corrections; this is the per-domain reliability score that already drives `domain_profiles`
- Auto-approve threshold uses *calibrated* confidence, not raw LLM verbalized confidence

### 14.5 Drift detection

- Per (domain × field), null-rate alerting: rolling 24h null rate > 2σ from 7-day baseline triggers a P2 alert
- Distribution drift on extracted values: median price, mean image count, mean title length per (domain × category) tracked daily; > 25% WoW shift triggers an alert
- Schema drift on inferred extraction shape: per (domain × day) hash of (set of keys, types); new key triggers an alert if 3+ in 1h
- Selector ladder logging: when the share of an LLM rung for a domain jumps from 5% → 40%, parser-broken alert (silent-LLM-rescue mitigation)

### 14.6 Rollout discipline (§ADR-AON-012)

- Every new parser / prompt / LLM model lives in shadow mode against the live link lane for ≥ 7 days
- Shadow metrics: per-field diff rate vs old (< 5% non-trivial), LLM cost delta, latency delta, confidence delta, reviewer correction rate on new outputs
- Promote to production only when (a) diff rate < 5% AND (b) human spot-check confirms diffs are improvements AND (c) latency/cost within budget
- Auto-rollback wired to golden-set regression > 1pp absolute

### 14.7 Walmart two-LLM pattern (high-business-cost fields)

For Tier 1 high-cost fields (price, GTIN, category, brand): one LLM extracts, a second (or rules-based verifier) cross-checks. Disagreement → review task. Per the research brief, this is the cleanest mitigation against silent-confident-wrong failures.

---

## 15. Economics

### 15.1 Cost model

```
cost_per_successful_extraction =
   fetch_cost (vendor anti-bot OR compute)
 + llm_cost (Layer E + optional Layer F vision)
 + storage_cost (raw HTML to S3, indexed bytes)
 + audit_log_cost
 + review_human_cost * (review_rate_per_extraction)
```

### 15.2 Cost guardrails

- LLM token caps per page (e.g. 5K input + 1K output max)
- Vendor escalation rules: free static → cheap browser → paid Web Unlocker only on hard failure
- Per-domain cost-per-success budget; > 5× median → force cheap-static-only lane or quarantine
- Per-tenant monthly extraction budget with circuit breaker
- LLM cost regression alert release-over-release

### 15.3 Reference capacity targets (HLD §24.2)

| Scale | Design behaviour |
|-------|------------------|
| 10K SKUs/month | Single API service, Redis, Postgres, one worker pool |
| 100K SKUs/month | Separate extraction, mapping, validation workers; read replicas if needed |
| 1M SKUs/month | Partition `source_artifacts` and `audit_events` by month/tenant; dedicated worker autoscaling; consider Bulk ETL path |

---

## 16. Migration plan (current state → target)

| Step | Risk | Mitigation |
|------|------|------------|
| Add new columns to `product_versions` (nullable) | Low | Expand-contract; nullable on add |
| Backfill `attributes_json` from existing `merchant_extensions_json.attributes` | Medium | Chunked migration job; dry-run mode; per-tenant isolation; revertible (column kept until verified) |
| Backfill `evidence_summary` from `extracted_facts` joins | Low | Read-only join; idempotent |
| Rewrite `applyApprovedDiff` to populate new columns | Medium | Cover with unit tests against golden fixtures; deploy under feature flag; shadow vs old behaviour for 7 days |
| Add JSON Schema validator at approval | Medium | Tier 1 categories first; Tier 2 permissive lets everything pass; shadow vs old for 7 days |
| Introduce `IngestionAdapter` contract; refactor `LinkAdapter` | Medium | New code path runs in parallel with legacy processor; flag-switch traffic; auto-rollback on regression |
| Verify Nango lane interop with new canonical model | Low | No code change in Nango path; verify only that approved Nango diffs populate new columns via the rewritten `applyApprovedDiff` |
| Build `CsvAdapter` from scratch | Low | New, no legacy to break |
| Add Layer A new parsers (NUXT, INITIAL_STATE, /products.json, Magento, WC, Algolia) | Low | Each is additive; per-parser shadow test |
| Integrate Bright Data Web Unlocker | Low | Vendor-side change; signed contract first; cost cap configurable |
| Add Playwright pool | Medium | Containerized; resource budgets enforced; trigger only on coverage signal |
| Add Layer F vision LLM | Low | Tier-3 only; explicit signal triggers |
| Build per-site parsers (Amazon, eBay, Walmart, Decathlon, Best Buy, IKEA, AliExpress, WooCommerce-generic, Magento-generic) | High effort | Sequenced over phases; each gets shadow + canary; selector health monitoring from day one |
| Build promotion pipeline (`schema-promotion-scan`) | Low | Read-only at first; admin approval before any write |
| Enable Postgres RLS | High risk | Run in shadow audit mode (log violations, don't enforce) for 7 days; verify zero false positives; then enforce |
| Migrate to high-cardinality event store (Honeycomb / ClickHouse) | Medium | Dual-write during transition; cut over after 30 days of parity |

---

## 17. Sequencing / phases

### Phase 1 — Canonical schema fix (Week 1)
- M-001 through M-008, M-016, M-019, M-020
- Rewrite `applyApprovedDiff` to populate `attributes_json` and `evidence_summary`
- Wire JSON Schema validator at approval (Tier 1 only; Tier 2 permissive)
- Backfill `attributes_json` from `merchant_extensions_json.attributes` (chunked, dry-run first)
- Acceptance: existing golden fixtures still process; `attributes_json` populated for new approvals; validator opens `missing_required_attribute` review tasks for Tier 1 misses

### Phase 2 — Ingestion spine (Weeks 2–3)
- `IngestionAdapter` interface in `packages/ingestion/types`
- Refactor link path: `LinkAdapter` + spine workers (`ingestion.classify/extract/map/validate/score`, `catalog.diff/approval`)
- Shadow new path against existing 465-line processor for 7 days
- Promote when diff rate < 5% on golden set
- Acceptance: link lane runs entirely through spine; old processor removed; per-stage audit_events emitted

### Phase 3 — Tiered Schema Maturity (Week 4)
- M-009 through M-013
- LLM-draft 150 seed schemas from Google Product Taxonomy
- Hand-refine top 30 (consumer electronics + apparel + outdoor + home essentials)
- Build `schema-promotion-scan` cron (read-only first; admin queue stub)
- Acceptance: Tier 1 schemas validate strictly; Tier 2 inferred categories auto-approve with permissive validator; promotion candidates surface in admin queue

### Phase 4 — CSV lane (Week 5)
- `CsvAdapter` implementation
- `POST /v1/ingestions/csv` endpoint
- Template definition locked
- Streaming parser; per-row + per-file artifacts; row-level validation errors
- Acceptance: 500-row golden CSV processes; malformed rows correctly rejected with row numbers; good rows reach canonical model

### Phase 5 — Nango lane canonical interop (Week 6, lightweight)
- **No refactor of Nango processor code** (§2.1.1)
- Verify that whenever the Nango engineer's path produces a `proposed_diff` that gets approved, the new `applyApprovedDiff` correctly populates `attributes_json` + `category_schema_version` for Nango-sourced records
- Coordinate on the canonical-model boundary only — confirm `extracted_facts` produced by the Shopify field-extractor still flow through cleanly post-spine refactor
- Acceptance: at least one Nango Shopify connection produces approved `product_versions` with non-empty `attributes_json` after this phase, exactly as before but with the new schema columns populated

### Phase 6 — Extraction pack expansion (Weeks 7–10)
- Layer A new parsers (NUXT, INITIAL_STATE, /products.json, Magento, WC, Algolia, RDFa, BreadcrumbList)
- JSON-LD cross-validator
- Layer B DOM heuristics consolidation (price, image-gallery, breadcrumb, spec-table, variant-selector)
- Layer C Playwright pool + escalation logic
- Layer D Bright Data Web Unlocker integration + CapSolver
- Layer E LLM gap-fill polish: structured-output / tool-use, prompt caching, calibrated confidence
- Per-parser shadow + canary; selector-health monitoring live
- Acceptance: hard-domain success rate doubles (Shein/Datadome-class sites); cost-per-successful-extraction within budget; LLM-rescue rate < 30% on parser-covered domains

### Phase 7 — Per-site parsers, tier-1 set built in parallel (Weeks 11–14, possibly extending into 15–16)
- **Per user direction (2026-05-16): build all 9 tier-1 retailer parsers in parallel** rather than sequenced
- Set: Amazon, eBay, Walmart, Decathlon, Best Buy, IKEA, AliExpress, WooCommerce-generic, Magento-generic
- Each parser: 50-product canary set + selector-health alerts + shadow mode for 7 days before promote
- Parser registry shape (§6.7) supports incremental enable/disable per domain, so any parser that misses the 7-day promotion bar stays in shadow without blocking the others
- Acceptance per parser: per-domain success rate ≥ 95% on the parser's canary set; LLM-rescue rate < 30% on that domain
- Acceptance for the phase: at least 7 of 9 parsers promoted to production; the 2 worst stay in shadow with a Phase-7.1 follow-up
- **Risk callout:** mature systems reach 50–300 parsers over years, not 9 in 4 weeks. Parallelizing 9 increases maintenance load proportionally (4–8 hours/month per parser). Acceptance for ALL nine in 4 weeks may slip — plan tolerates this with the "7 of 9" partial acceptance

### Phase 8 — Quality + observability hardening (Weeks 15–18)
- Per-(extractor × category × source-type) isotonic calibrators
- Per-(domain × field) Beta-binomial priors
- Drift detection (null-rate, distribution drift, schema drift)
- Selector ladder logging
- High-cardinality event store cutover
- Operational dashboards (fleet, domain health, field completeness, parser versions, cost, anomaly queue, LLM-specific)
- Acceptance: dashboards live; SLO error budgets visible; all alerts wired

### Phase 9 — Vision LLM tier-3 + multi-source verification (Weeks 19–22)
- Layer F vision LLM (Sonnet-class) integration
- Triggered only by image-spec signal (apparel size charts, electronics with infographic specs)
- Layer H multi-source verification: when same GTIN appears across multiple ingestions, produce proposed_diff against existing product with reconciled values
- Conflict resolution policy + `value_conflict` review task
- Acceptance: vision LLM only fires on documented vertical signals; multi-source verification reduces duplicates and raises composite confidence on cross-sourced products

### Phase 10 — Multi-tenant overlays + adversarial tests (Weeks 23–24)
- `tenant_category_overlays` table
- JSON Schema `allOf` composition at validator
- Per-tenant noisy-neighbor ranker
- Adversarial isolation tests in CI
- Acceptance: tenant A can declare stricter requirements without affecting tenant B; isolation tests pass; noisy neighbor surfaces in dashboard

---

## 18. Exit criteria

Phase complete when:
- All migrations in the phase applied to staging with backfill verified
- Acceptance test set passes (per-phase set defined above)
- Shadow vs production parity ≥ 95% for 7 consecutive days on links / rows in scope
- Cost-per-successful-extraction within budget
- No P1 regressions on prior-phase functionality
- Runbooks updated for new failure modes
- Dashboards reflect new metrics
- Engineering review checklist signed

Production-ready (post Phase 10) when (HLD Appendix A adapted):
- Every failed artifact replayable from immutable evidence
- All approved changes create new `product_versions`; old versions remain readable
- Known marketplace fields map deterministically; ambiguous fields create review tasks
- Embeddings retrieval is behind feature flag; cannot auto-approve alone
- Reviewer actions create audit events and proposed_diff transitions
- All extractions have idempotency key, audit event, cost ledger row
- Provider tokens not logged; tenant IDs enforced; RBAC checked
- Dashboards show ingestion rate, anomaly rate, sync (deferred) failures, cost per SKU
- 100K SKU dry run completed in staging with acceptable queue age
- Replay, vendor outage, auth failure, projection-failure (deferred), bad-auto-approval runbooks tested

---

## 19. Open questions

| Question | Default assumption | Owner | Deadline |
|----------|--------------------|-------|----------|
| Vector store choice (pgvector vs dedicated) | pgvector in Postgres at launch | Platform | Before Phase 6 |
| ~~Which LLM provider for primary gap-fill~~ | **Resolved 2026-05-16: Groq via existing `OpenAIProvider` baseUrl override; Llama 3.3 70B Versatile primary, Llama 3.1 8B Instant for cheap classification, Llama 3.2 90B Vision for tier-3** | — | — |
| ~~Which vendor for anti-bot at full production load~~ | **Resolved 2026-05-16: ScrapingBee at $49/mo for dev → early prod; revisit upgrading to Bright Data Web Unlocker when monthly extraction volume justifies the $500/mo minimum** | — | — |
| Whether to publish typed SDK / API contract this phase | No — deferred (out of scope §2.3) | Product | After Phase 10 |
| Whether Channel projection / multi-marketplace publish moves into Phase 11+ | Yes, separate spec | Product | After Phase 10 |
| Per-tenant LLM budget defaults | $50/tenant/month soft cap; $500 hard cap; per-tenant override | Finance + Product | Before Phase 8 |
| Synonym promotion threshold (tenants × usages) | ≥ 10 uses across ≥ 3 trust-score-passing tenants | Catalog | Before Phase 8 |
| Tier 2 → Tier 1 promotion threshold | ≥ 50 products + ≥ 8 attribute keys present in ≥ 80% | Catalog | Before Phase 3 |
| Backfill of existing `merchant_extensions_json.attributes` strategy | Chunked migration job with dry-run first; old column retained until verified | Platform | Before Phase 1 |
| Whether Playwright lives in-process or as a separate service (Browserless / Steel) | In-process at < 50 concurrent; revisit at scale | Platform | Before Phase 6 |
| Object storage choice | **Resolved 2026-05-16: MinIO in docker-compose for dev; S3-compatible SDK so production swap is env-var-only (target: Cloudflare R2 or AWS S3 when production)** | — | — |
| Per-site parser launch set + sequencing | **Resolved 2026-05-16: all 9 tier-1 parsers in parallel during Phase 7; partial acceptance (7 of 9) allowed** | — | — |
| Groq model defaults | **Resolved 2026-05-16: Llama 3.3 70B Versatile (gap-fill), Llama 3.1 8B Instant (classification), Llama 3.2 90B Vision (tier-3)** | — | — |

---

## 20. References

### Internal
- `docs/Aonex_Production_HLD_Catalog_Ingestion_Distribution_v2.docx` — the HLD this spec implements
- `packages/db/src/schema/products.ts` — current schema (target of Phase 1 migrations)
- `packages/db/src/schema/category.ts`, `attributes.ts`, `extraction.ts`, `ingestion.ts` — reference data tables
- `apps/worker/src/processors/link-extract.processor.ts` — current 465-line processor (target of Phase 2 refactor)
- `apps/worker/src/services/link-catalog-pipeline.ts` — current link path; splits into LinkAdapter + spine
- `packages/catalog/catalog-service/src/index.ts:42-155` — `applyApprovedDiff` (target of Phase 1 rewrite)
- `packages/ingestion/semantic-mapper/src/map.ts` — already faithful to HLD §10; no changes
- `packages/ingestion/field-extractor/src/registry.ts` — per-marketplace registry; basis for NangoAdapter

### Field-reconnaissance briefs (from this design conversation)
1. **2026 state of product link extraction** — JSON-LD coverage ~60% on e-commerce sites (rising), 15–30% invalid; framework state extractors (`__NEXT_DATA__`, Shopify `/products.json`) are highest-value; build extractors / buy anti-bot is unanimous; LLM gap-fill commodity at ~$0.0003–0.001/page; Diffbot Product API ~$0.001/page is the buy alternative; per-site parsers cost 4–8 hours/month each in maintenance
2. **PIM/catalog architecture comparison** — Akeneo Family Variants ≈ our typed Layer 2 + Layer 3; Amazon SP-API Product Type Definitions = canonical schema-governance precedent; JSONB-with-GIN runs 36× smaller than EAV; per-tenant overlay via JSON Schema `allOf` is the multi-tenancy pattern; expand-contract migrations are mandatory; reviewer fatigue is the silent killer
3. **Quality + observability for extraction systems** — golden datasets 100–200 fixtures per (category × source-type); LLM raw confidences uncalibrated (ECE 0.12–0.40); isotonic regression with ≥ 100 examples cuts ECE > 75%; shadow mode mandatory for every parser/prompt/model change; selector-ladder logging catches silent LLM-rescue; per-(domain × field) Beta-binomial priors as reliability scores; Walmart two-LLM extract+verify is the silent-confident-wrong mitigation; cost-per-successful-extraction (not raw spend) is the only meaningful cost metric

### External (for adapter implementation)
- Google Product Taxonomy — https://support.google.com/merchants/answer/6324436
- Amazon Product Type Definitions API — https://developer-docs.amazon.com/sp-api/docs/product-type-definitions-api
- Shopify metafield definitions — https://shopify.dev/docs/apps/build/metafields/definitions
- Akeneo Family Variants — https://help.akeneo.com/serenity-build-your-catalog/30-serenity-manage-your-families-and-variant-families
- JSON Schema 2019-09 — https://json-schema.org/specification
- Schema.org Product — https://schema.org/Product
- Bright Data Web Unlocker — https://docs.brightdata.com/scraping-automation/web-unlocker/features
- BullMQ — https://docs.bullmq.io/
- pgvector — https://github.com/pgvector/pgvector
- OpenTelemetry — https://opentelemetry.io/docs/concepts/semantic-conventions/
- OWASP LLM Prompt Injection Prevention — https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html

---

## Appendix A — End-to-end example: Decathlon tent

Walks the worked example from §4 / brainstorming conversation.

**Input:** `https://www.decathlon.com/products/mh100-2-person-tent`

**Lane:** Link → `LinkAdapter.normalize`

**Layer A:** JSON-LD parser pulls `title`, `brand="Quechua"`, `price=49.99`, `currency="EUR"`, `images[]`, `description`. Confidence: 0.95 (method prior).

**Layer B:** DOM spec-table heuristic pulls (`Capacity: 2 people`, `Packed weight: 2.4 kg`, `Peak height: 110 cm`, `Waterproof rating: 2000 mm`, `Packed dimensions: 58 × 16 × 16 cm`). Confidence: 0.75 (DOM heuristic prior).

**Category detector:** LLM returns `outdoor/camping/tents`, confidence 0.94.

**Category schema lookup:** Tier 1 `outdoor/camping/tents` (hand-refined). Required: `[capacity_persons, season_rating, packed_weight_grams, peak_height_cm, waterproof_rating_mm]`.

**Semantic mapper:**
- `capacity` (raw, integer 2) → `capacity_persons` (synonym match, score 0.93 after type/category compat)
- `packed_weight` ("2.4 kg") → `packed_weight_grams` (canonical mapping with unit conversion kg → g; value 2400)
- `peak_height` ("110 cm") → `peak_height_cm` (unit-preserved)
- `waterproof_rating` ("2000 mm") → `waterproof_rating_mm`
- `packed_dimensions` ("58 × 16 × 16 cm") → `dimensions_cm` (Layer 1; parsed to `{l: 58, w: 16, h: 16}`)

**Validator:** missing `season_rating`. Opens `review_task` type `missing_required_attribute` with payload `{required: "season_rating", category: "outdoor/camping/tents", suggestions: ["3-season", "4-season"]}`.

**Reviewer** consults description PDF on Decathlon page, enters `season_rating: "3-season"`, approves.

**Approval:** `applyApprovedDiff` runs JSON Schema validation against effective schema (Tier 1 + no tenant overlay): all required ✓, all types ✓, all units ✓. Inserts `product_version` row:

```jsonc
{
  "title": "MH100 2-Person Tent — Fresh & Black",
  "brand": "Quechua",
  "manufacturer_part_number": "8492348",
  "base_price": 49.99,
  "currency": "EUR",
  "weight_grams": 2400,
  "dimensions_cm": {"l": 58, "w": 16, "h": 16},
  "images": [...],
  "category_path": "outdoor/camping/tents",
  "category_schema_version": "2026-05-08.tents.v1",
  "category_confidence": 0.94,
  "attributes_json": {
    "capacity_persons": 2,
    "season_rating": "3-season",
    "packed_weight_grams": 2400,
    "peak_height_cm": 110,
    "waterproof_rating_mm": 2000,
    "color": "Green",
    "pole_material": "fibreglass",
    "footprint_cm": [220, 145]
  },
  "confidence_score": 0.87,
  "evidence_summary": {
    "sourceUrl": "https://www.decathlon.com/products/mh100-2-person-tent",
    "extractionMethods": ["json_ld", "dom_spec_table", "llm_gap_fill"],
    "extractorVersion": "...",
    "mapperVersion": "deterministic-synonym@1.0.0",
    "policyVersionId": "...",
    "modelName": "claude-haiku-...",
    "promptTokens": 1245,
    "completionTokens": 312,
    "estimatedCostUsd": 0.0009
  }
}
```

Audit event chain: `ingestion.artifact_created → ingestion.extraction_started → ingestion.extraction_completed → mapping.completed → validation.review_required → review.opened → review.edited_and_approved → catalog.version_created`.

---

## Appendix B — End-to-end example: Random umbrella

**Input:** `https://random-umbrellashop.com/products/auto-open-windproof`

**Lane:** Link → `LinkAdapter.normalize`

**Layer A:** JSON-LD thin (only `name`, `image`, `offers.price`). OpenGraph present.

**Layer B:** No spec table. Description has details.

**Coverage check:** ≥ 50% of Layer 1 core missing (no brand, no manufacturer_part_number, no dimensions). Layer E LLM gap-fill triggered.

**Layer E:** Sends cleaned description + DOM slice + structured-data context to Haiku. Returns: `brand="StormGuard"`, `color="Black"`, `opening_mechanism="automatic"`, `frame_material="fiberglass"`, `canopy_diameter_cm=105`, `panel_count=8`, `wind_resistance_mph=55`, `weight_grams=380`, `compact_when_folded=true`.

**Category detector:** LLM returns `luggage_bags/umbrellas`, confidence 0.82.

**Category schema lookup:** No Tier 1 schema. Falls to **Tier 2 (Inferred)**.

**Validator:** Tier 2 permissive — only Layer 1 core required. Title ✓, brand ✓, base_price ✓. Passes.

**Scoring:** policy engine produces 0.81 composite (no GTIN drops identity_score; brand+title strong; Tier 2 inferred bonus).

**Routing:** Tier 2 single-source threshold is 0.85; composite 0.81 falls below. Opens `review_task` type `low_confidence_mapping` with the top-3 mapping candidates and the structured-data evidence. Reviewer inspects the page, accepts the extracted attributes as-is, and approves. On approval, `applyApprovedDiff` inserts:

```jsonc
{
  "title": "Auto-Open Windproof Travel Umbrella",
  "brand": "StormGuard",
  "manufacturer_part_number": null,
  "base_price": 24.99,
  "currency": "USD",
  "weight_grams": 380,
  "dimensions_cm": null,
  "images": [...],
  "category_path": "luggage_bags/umbrellas",
  "category_schema_version": null,            // ← Tier 2, no formal schema yet
  "category_confidence": 0.82,
  "attributes_json": {
    "color": "Black",
    "opening_mechanism": "automatic",
    "frame_material": "fiberglass",
    "canopy_diameter_cm": 105,
    "panel_count": 8,
    "wind_resistance_mph": 55,
    "compact_when_folded": true
  },
  "confidence_score": 0.81,
  "evidence_summary": {
    "sourceUrl": "https://random-umbrellashop.com/products/auto-open-windproof",
    "extractionMethods": ["json_ld", "opengraph", "llm_full_extraction"],
    ...
  }
}
```

Subsequent ingestion of similar umbrellas increments the count in `luggage_bags/umbrellas`. After 50 products with consistent attribute keys, `schema-promotion-scan` proposes a Tier 1 schema; admin reviews, approves; the category graduates to Tier 1 with required = `[opening_mechanism, frame_material, canopy_diameter_cm]` (the 80%-consistent set).

---

## Appendix C — End-to-end example: iPhone from Apple

**Input:** `https://www.apple.com/shop/buy-iphone/iphone-15-pro/...`

**Lane:** Link → `LinkAdapter.normalize`

**Layer A:** Rich `__NEXT_DATA__` (Apple's marketing pages are Next.js). All Layer 1 + most Layer 3 fields present. Confidence: 0.97 (method prior).

**Layer B:** Not needed — Layer A coverage complete.

**Layer C/D/E/F:** Not triggered.

**Variant extractor:** Storage (128/256/512/1TB) × Color (4 colors) → 16 variant combinations parsed from `__NEXT_DATA__`.

**Category detector:** Deterministic — `productType: "iPhone"` in structured data maps to `electronics/mobile_phones` via `attribute_mappings`. Confidence: 0.99.

**Category schema lookup:** Tier 1 (hand-refined seed). Required: `[ram_gb, storage_gb, screen_size_inches, os, battery_mah, network_type]`.

**Semantic mapper:** all required mapped deterministically + with high synonym confidence. `attributes_json` populated. Variant_axes extracted to per-variant rows.

**Validator:** all required ✓. All units ✓. All enum values within allowed set.

**Scoring:** 0.96 composite (GTIN present + brand+model both strong + variants complete).

**Auto-approve:** 0.96 ≥ 0.90 → auto-approved. `product_version` + 1 `product_variant` + 16 `product_variant_versions` created.

**Multi-source verification (Phase 9):** When the same GTIN-194253401347 appears later from an Amazon URL, deduplicator hits `product_identities`, the new extracted facts produce a `proposed_diff` against the existing iPhone product, with cross-source attestation raising composite confidence. Field-level voting: Amazon's price might differ from Apple's; reconciliation policy prefers manufacturer site (Apple) for base_price unless reviewer overrides.
