# Anomaly Lab Redesign — Staging Gate — Design Spec

**Status:** Approved (brainstorming, 2026-05-25)
**Supersedes:** `~/docs/superpowers/specs/2026-05-21-anomaly-lab-redesign-design.md` (the
"soft-quarantine inside `catalog_products`" approach). This spec replaces that with a
**hard-block staging** model. The earlier spec's "reuse the intern UI" assumption is void —
the existing frontend is discarded and rebuilt.
**Depends on:** the completed catalog redesign — source adapters (`AdapterOutput`),
identity resolver, `writeAdapterOutput`, `reconciliation_overrides`, the outbox.

---

## 1. Goal

Rebuild the Anomaly Lab as the **single human gate** that guarantees the catalog is "built
perfectly": every ingest — link or connector — must satisfy the catalog's required
parameters before it is allowed in. Ingests that don't qualify are **held in a dedicated
staging area** (never written to `catalog_products`) and surfaced in the lab, where a human
fills the gaps and approves, at which point the product is **promoted** into the clean
catalog.

The lab is, in one surface, three layers:

1. **Gate** — decides what is catalog-ready vs. held.
2. **Workbench** — where a reviewer fills/corrects, links duplicates, and approves.
3. **Dashboard** — analytics over the staging queue (volume, reasons, sources, age, throughput).

**Cohering idea:** the catalog stays pristine *by construction* — only clean, complete,
human-blessed (when needed) products live in `catalog_products`. Everything questionable
waits in `staged_products`.

---

## 2. Why the current lab "sucks"

| Layer | State today |
|---|---|
| `packages/anomaly-lab/` | One-line stub: `export const PHASE = 4`. |
| Completeness gate | Does not exist. Incomplete ingests write straight into `catalog_products`. |
| Staging area | Does not exist. |
| 9 detectors (`policy-engine/src/detectors/*`) | Real, but only run inline in the legacy link-extract path; never gate the catalog write. |
| Frontend `(authenticated)/ingestion/anomaly-lab/` | Intern-built, vibe-coded, fed almost nothing. Discarded. |
| Connector ingest | Passthrough to `catalog_products` with no quality gate. |

The catalog has no admission control. The lab is a UI shell over an empty signal stream.

---

## 3. Locked decisions (brainstorming, 2026-05-25)

| # | Decision | Implication |
|---|---|---|
| 1 | **Lab = gate + workbench + dashboard, layered.** | One surface, three concerns. Dashboard is scoped to staging-queue analytics (decision 8). |
| 2 | **Hard block.** Failing ingests never enter `catalog_products`; held in a dedicated `staged_products` area; promoted to the catalog only on human approval. | New staging table + promotion path. Catalog stays pristine. |
| 3 | **Gate = global core minimum completeness + critical anomalies.** Missing a global-core required field OR a critical anomaly (impossible price, identity conflict, hard duplicate) holds the product. Milder anomalies are informational badges. | Single `CANONICAL_MINIMUM` const + a `BLOCKING_SIGNALS` set. Category-specific attributes are nice-to-have, not gating. |
| 4 | **Updates to live products always flow.** A confident identity match to a *live* catalog product is an enrichment → straight to catalog, never staged. The gate guards *new* products only. | Identity resolution runs before the gate. Lossless append means an update that omits a field can't drop a live product below the bar. |
| 5 | **Multi-source, per-channel.** Same product from Shopify then Amazon → one catalog product, both prices recorded per-channel. | Reuses the catalog's per-`(attribute, channel, locale)` observation model. No new work in the catalog itself. |
| 6 | **Identity resolved at ingest, against live catalog AND staged items.** The lab shows likely matches; promotion enriches the matched product. | `resolveIdentity` gains an `includeStaged` mode. Match candidates stored on the staged row. |
| 7 | **Sources v1: link + connectors.** Gate sits at the source-agnostic convergence point. CSV deferred to v2. | One `admitOrStage` chokepoint; both worker paths repoint at it. |
| 8 | **Reach: staging-only.** The lab handles pending items awaiting promotion. Live-catalog anomaly monitoring is out of v1. | No detectors over live products in v1. Dashboard = staging-queue analytics. |
| 9 | **Reviewer actions v1:** fill+approve→promote (pinned overrides), reject/discard, merge/link-to-existing, LLM-assisted auto-fill (on-demand). | Four action endpoints. LLM suggestions never auto-applied. |
| 10 | **Staging representation = dedicated table (Approach A).** Not soft-status inside `catalog_products` (rejected: violates hard block), not `source_artifacts`+`review_tasks` payloads (rejected: rots). | New `staged_products` table; resolver becomes staging-aware. |

---

## 4. Architecture

```
  link ingestion ──┐
  Nango connector ─┴─→  SourceAdapter  ──→  AdapterOutput
                                              │
                                              ▼
                                   admitOrStage(adapterOutput, ctx)   ← new chokepoint
                                              │
            ┌──── 1. resolveIdentity({ includeStaged: true }) ────┐
            ▼                                                     ▼
  confident match to LIVE product                    no confident live match
            │                                                     │
            ▼                                          2. evaluateGate():
   writeAdapterOutput()                                  • CANONICAL_MINIMUM satisfied?
   (enrich, per-channel; updates                         • any BLOCKING_SIGNALS fired?
    never blocked)                                              │
                                                    ┌───────────┴───────────┐
                                                  pass                     fail
                                                    │                       │
                                            writeAdapterOutput()      stageProduct()
                                            (new product enters       → staged_products
                                             catalog)                 (+ verdict, candidates,
                                                                        evidence pointer)
```

Confident match to an existing **staged** item → the incoming observations **accumulate**
onto that staged row (two incomplete ingests of one product = one card). Fuzzy match
(0.5–0.7) to live or staged → staged as new with an `identity_conflict` signal + candidate
list for the reviewer to confirm.

**Three new pieces; everything else reuses what exists:**

1. **`admitOrStage`** — new orchestration entry in `catalog-service`. Runs identity
   resolution, then the gate, then routes to `writeAdapterOutput` or `stageProduct`.
   Both worker ingest paths call this instead of `writeAdapterOutput` directly.
2. **Staging area** — `staged_products` table + `stageProduct` / `promoteStagedProduct` /
   `rejectStagedProduct` / `linkStagedProduct` operations.
3. **Lab API + fresh frontend** — product-centric queue, workbench, and staging analytics.

The 9 detectors are reused as **pure signal functions**; their old inline link-extract
routing is dropped. The `packages/anomaly-lab` stub package is deleted.

---

## 5. Components

### 5.1 New files

| Path | Responsibility |
|---|---|
| `packages/catalog/catalog-service/src/canonical-minimum.ts` | `CANONICAL_MINIMUM` — the global required-field bar. v1 list: `title` (non-empty string), `brand` (non-empty string), `pricing.primary` (currency + ≥1 tier amount), `category_path` (non-empty), and an identifier (≥1 of `gtin` / `mpn` / `primary_identifier` non-empty). Presence rule: exists, non-empty after trim, type matches the canonical attribute definition. |
| `packages/catalog/catalog-service/src/gate/evaluate-gate.ts` | Pure `evaluateGate(observations, identityResolution, signals): GateVerdict` where `GateVerdict = { admit: boolean; missingFields: string[]; blockingSignals: Signal[]; infoSignals: Signal[] }`. No I/O. |
| `packages/catalog/catalog-service/src/gate/blocking-signals.ts` | `BLOCKING_SIGNALS` set (see §8). One-line change to promote/demote a detector. |
| `packages/catalog/catalog-service/src/gate/run-detectors.ts` | Adapts the 9 `policy-engine` detectors to the gate signature `(observations, identityResolution) → Signal[]`. |
| `packages/catalog/catalog-service/src/admit-or-stage.ts` | The chokepoint orchestrator (§4). |
| `packages/catalog/catalog-service/src/staging/stage-product.ts` | Insert/accumulate a `staged_products` row from a gate-failed `AdapterOutput`. |
| `packages/catalog/catalog-service/src/staging/promote-staged.ts` | `promoteStagedProduct(stagedId, fills, confirmedMatch?)` — pins, synthetic observations, `writeAdapterOutput`, gate re-check, status flip, event. |
| `packages/catalog/catalog-service/src/staging/reject-staged.ts` | `rejectStagedProduct(stagedId, userId)`. |
| `packages/catalog/catalog-service/src/staging/link-staged.ts` | Confirm a match candidate (live or staged) and route promotion to it. |
| `packages/db/src/schema/staged-products.ts` | Drizzle schema (§6). |
| `packages/db/migrations/0022_staged_products.sql` | Hand-written migration (matches catalog-redesign migration style). Re-number if other migrations land on this branch first. |
| `apps/api/src/handlers/anomaly-lab.ts` | Reads: `GET /lab/queue` (paginated, severity+age sorted, filterable), `GET /lab/staged/:id` (canonical view + per-field provenance + match candidates), `GET /lab/staged/:id/evidence` (source-aware), `GET /lab/stats` (dashboard analytics). |
| `apps/api/src/handlers/lab-actions.ts` | Writes: `POST /lab/staged/:id/approve`, `/reject`, `/link`, `/suggest`. |
| `apps/api/src/routes/anomaly-lab.ts` | Hono route definitions, mounted under `/api/lab`, JWT + tenant-scoped. |
| `packages/catalog/catalog-service/src/staging/llm-suggest.ts` | On-demand fill suggester wrapping `@aonex/ingestion-llm-extractor`; budget-capped; returns `{field:{value,confidence,rationale}}`; never auto-applies. |

### 5.2 Modified files

| Path | Change |
|---|---|
| `packages/catalog/catalog-service/src/identity-resolver.ts` | Add `includeStaged` mode: run the same gtin→mpn+brand→fuzzy matching over `staged_products` (pending only); return candidates tagged `kind: 'live' \| 'staged'`. |
| `apps/worker/src/services/new-catalog-link-path.ts` | Call `admitOrStage` instead of `writeAdapterOutput`. |
| `apps/worker/src/services/new-catalog-shopify-path.ts` | Call `admitOrStage` instead of `writeAdapterOutput`. |
| `apps/api/src/composition-root.ts` | Wire the new `/api/lab` routes + handlers. |
| Frontend `(authenticated)/ingestion/anomaly-lab/*` | **Deleted and rebuilt fresh** (§9). |

### 5.3 Deleted / deprecated

- `packages/anomaly-lab/` — stub package; delete.
- Inline `route()` invocation in the legacy link-extract path (detector routing) — superseded by `run-detectors.ts` inside the gate.
- The intern frontend under `(authenticated)/ingestion/anomaly-lab/` — replaced.

---

## 6. Data model — `staged_products`

| Column | Type | Notes |
|---|---|---|
| `staged_product_id` | uuid pk | |
| `tenant_id`, `merchant_id` | fk | tenant-scoped; `onDelete: restrict` |
| `proposed_identity` | jsonb | `{ gtin?, mpn?, brand?, model_number? }` as extracted |
| `observations` | jsonb | accumulated `AdapterOutput` shape: per-field value/source/confidence/channel. Drives the workbench form and per-field provenance. |
| `denorm_title`, `denorm_brand` | text | for list rendering + sort |
| `denorm_price`, `denorm_currency` | numeric / text | for list rendering + sort |
| `source_kind` | text | `link` / `connector:shopify` / `connector:ebay` / … |
| `source_artifact_id` | uuid | evidence pointer into `source_artifacts` |
| `channel_code` | text | resolved channel for this ingest |
| `gate_verdict` | jsonb | `{ missingFields: string[], signals: [{kind, severity, blocking}] }` |
| `match_candidates` | jsonb | `[{ productId, score, kind: 'live'\|'staged' }]` |
| `human_fills` | jsonb | reviewer-supplied values (set on approve) |
| `status` | text | `pending` \| `promoted` \| `rejected`; default `pending` |
| `created_at`, `updated_at` | timestamptz | `updated_at` backs optimistic concurrency |
| `resolved_by`, `resolved_at` | uuid / timestamptz | who/when promoted or rejected |

Indexes: `(tenant_id, status, created_at)` for the queue; GIN on `gate_verdict` for
reason-faceted dashboard counts. `catalog_products.status` is **unchanged** — staged items
never live there.

---

## 7. Data flow

### 7.1 Link ingest, missing brand + identifier

```
1. POST /api/ingestions/link → 202, LINK_EXTRACT job.
2. Worker: fetch + extract → AdapterOutput { title, price, category; brand=∅, gtin=∅ }.
3. admitOrStage():
   a. resolveIdentity({includeStaged:true}) → no gtin/mpn, fuzzy < 0.5 → no match.
   b. evaluateGate → missing [brand, identifier] → admit=false.
   c. stageProduct → INSERT staged_products(status=pending,
        gate_verdict={missingFields:[brand,identifier], signals:[…]},
        match_candidates=[], source_artifact_id=…).
4. Lab queue: "Cool T-Shirt — missing: brand, identifier"  (NOT in catalog).
5. Reviewer opens it → evidence pane shows source HTML; optionally clicks "Suggest fills"
   (LLM proposes brand='Acme'); fills brand='Acme', gtin='12345678905'; clicks Approve.
6. promoteStagedProduct(id, fills) — ONE TRANSACTION:
   - re-run gate with fills → complete ✓
   - INSERT reconciliation_overrides pins (source='manual:lab', pinned_by=userId) for
     brand + gtin; add synthetic manual:lab observations (confidence=1.0)
   - build corrected AdapterOutput; writeAdapterOutput() → enters catalog_products
   - UPDATE staged_products SET status='promoted', resolved_by, resolved_at
   - emit catalog event
7. Channel publishers consume the event → product is live.
```

### 7.2 Shopify-then-Amazon (multi-source enrichment)

```
- Shopify ingest (complete) → admitOrStage → no match, gate passes → writeAdapterOutput →
  live catalog product P with channel=shopify pricing.
- Amazon ingest of the same product → admitOrStage → resolveIdentity matches P
  (gtin exact, kind='live') → enrichment → writeAdapterOutput appends channel=amazon
  pricing to P. NOT staged. One product, two per-channel prices.
- If the Amazon copy is only a fuzzy match (0.5–0.7) → staged as new with identity_conflict
  + candidate P; reviewer confirms via Link → promotion enriches P instead of creating a
  duplicate.
```

### 7.3 Variant flows

- **Reject:** `status='rejected'`; observations + evidence retained for audit; never
  promoted; drops from the queue. A later re-ingest creates a fresh `pending` row (no
  permanent SKU block).
- **Two incomplete ingests, same product:** the second confidently matches the first
  staged row → observations accumulate; one card, richer evidence.

---

## 8. Detector classification

`run-detectors.ts` runs all 9; `evaluateGate` partitions by `BLOCKING_SIGNALS`.

| Detector | v1 role |
|---|---|
| `missing-required-attribute` | **BLOCK** (this is the completeness gate) |
| `price-anomaly` | **BLOCK** |
| `identity-conflict` | **BLOCK** |
| `cross-source-conflict` | inform |
| `value-contradiction` | inform |
| `unit-ambiguity` | inform |
| `variant-incomplete` | inform |
| `category-ambiguous` | inform (missing category caught by completeness; *ambiguous* category is a badge) |
| `low-field-confidence` | inform |

Blocking signals force staging even when `CANONICAL_MINIMUM` is satisfied. Informational
signals annotate the staged row (badges) but never, by themselves, stage a product —
except that a product is only ever in the lab if it failed the gate for *some* blocking
reason (completeness or a blocking signal).

**The gate (and therefore all blocking signals) runs only on the new-product branch of
`admitOrStage`.** A confident identity match to a *live* product is an enrichment and
**skips the gate entirely** (per decision 4, "updates always flow," and decision 8,
"staging-only reach"). Consequence: a blocking anomaly carried by an enrichment to a live
product — e.g. an impossible Amazon price on a product already live from Shopify — does
**not** stage it in v1; live-product anomaly handling is explicitly v2 (§13). Only the
*first* (admitting) ingest of a product is gated.

---

## 9. Frontend (rebuilt fresh)

Route `(authenticated)/ingestion/anomaly-lab`, product-centric, built with the
`frontend-design` skill during implementation:

- **Dashboard header** — staging analytics: counts by reason, by source, age buckets,
  daily promoted/rejected throughput, oldest-pending. (`GET /lab/stats`.)
- **Queue** — one row per staged product: missing-field chips, anomaly badges, a
  "matches live product" indicator; sort by age/severity/source; filter by source/reason.
- **Detail + evidence** — canonical form (each global-core field: current value / source /
  confidence; missing highlighted with inputs), a **"Suggest fills"** button, a
  **match-candidates** panel, and a **source-aware evidence pane** (HTML iframe/snippet for
  link; JSON tree for connector).
- **Action toolbar** — Approve · Reject · Link/Merge · Suggest.

---

## 10. Error handling

| Failure | Behavior |
|---|---|
| `evaluateGate` throws | Txn rolls back; nothing staged or written; BullMQ retry → DLQ + alert. |
| Adapter throws on malformed source | No staged row; surfaces as an ingest-level **failure card** (reuse `extraction_failures`). |
| Approve, post-fill still incomplete | `400 { stillMissing: [...] }`; full rollback; no partial pins. UI keeps session, marks fields red. |
| Concurrent approve | Optimistic lock on `staged_products.updated_at`; second submit → `409` + latest state. |
| LLM suggest fails | `200` with empty suggestions + note; reviewer fills manually (never fatal). |
| Promotion `writeAdapterOutput` fails | Staged row stays `pending`; error surfaced; retryable. |
| Cross-tenant access | `404` (no existence leak). |

---

## 11. Testing

- **Unit (no DB):** `evaluateGate` (complete→admit, missing→hold with field list, blocking
  signal→hold); `canonical-minimum` snapshot; detector classification; staging-aware
  resolver candidate logic; `llm-suggest` shape (mock LLM, never auto-applies).
- **Integration (real Postgres, per-test rollback):** `admitOrStage` routing matrix
  (new-incomplete→stage, new-complete→catalog, live-match→enrich-no-stage,
  ambiguous→stage+candidates, staged-match→accumulate); `promote`→catalog + pins + event;
  `reject`; `link`-to-live→enrich; concurrent approve→409; tenant isolation→404.
- **E2E (Playwright):** (1) link-incomplete → queue → fill → approve → appears in catalog;
  (2) connector-complete → *not* in queue, publishes (guards against over-staging);
  (3) Shopify+Amazon same product → one catalog product, two channel prices via Link.
- **Coverage:** every path in `evaluate-gate.ts`, `admit-or-stage.ts`, the staging
  operations, and `lab-actions.ts`; every detector one positive + one negative; every §10
  failure mode at least one test.

---

## 12. Phasing

1. **Gate + staging core** — `CANONICAL_MINIMUM`, `evaluate-gate`, `run-detectors`,
   `blocking-signals`, `staged_products` schema + migration, `admit-or-stage`, repoint both
   worker paths. Staging-aware `resolveIdentity`.
2. **Reviewer-actions API + promotion** — `promote` (pins + synthetic observations +
   `writeAdapterOutput` + gate re-check), `reject`, `link`; `/api/lab` read + write
   endpoints; concurrency + tenant scoping.
3. **LLM suggest** — `llm-suggest.ts` + `/lab/staged/:id/suggest`, budget-capped, on-demand.
4. **Fresh frontend** — queue + dashboard + detail + evidence + actions.
5. **Detector classification wiring + dashboard stats** — `BLOCKING_SIGNALS`, info-badge
   surfacing, `/lab/stats`.

---

## 13. Out of scope (v2+)

- CSV source ingestion (parser, upload endpoint, adapter).
- Live-catalog anomaly monitoring (detectors over already-live products) and acting on
  live products from the lab.
- Bulk actions (approve/fill many at once).
- Re-extraction / re-fetch triggers from the lab.
- Auto-approve after SLA timeout.
- Per-tenant override of `CANONICAL_MINIMUM`.
- "Previously rejected — revive?" hint on re-ingest.
