# Frontend Integration — Catalog + Anomaly Lab — Design Spec

**Status:** Approved (brainstorming, 2026-05-25)
**Depends on:** the staging-gate backend core (`2026-05-25-anomaly-lab-staging-gate-design.md`, branch `feat/anomaly-lab-staging-gate`) — the domain functions `promoteStagedProduct` / `rejectStagedProduct` / `linkStagedProduct` / `stageProduct` exist; this spec adds their HTTP surface and the UI.

## 1. Goal

Make the new backend usable by humans: a **focused-triage anomaly lab** (clear staged products into the catalog fast) and a **catalog browse/detail** UI that shows the multi-source richness. UX priority: to-the-point, informative, productivity. No new frontend dependencies — extend the existing typed `api.ts` client + plain fetch.

## 2. Context (current state)

- **Backend:** catalog API exists (`/api/catalog/products`, `/:id`, per-attribute provenance). The new **lab API does NOT exist** — `staged_products` + the promote/reject/link domain functions have no HTTP endpoints. The legacy `/api/review/*` (task-centric) endpoints exist but are the OLD model and are out of scope.
- **Frontend:** Next.js 15 (app router) + React 19 + Tailwind 3. Single typed client `src/lib/api.ts` (`request<T>` → `NEXT_PUBLIC_API_URL`, default `:8787`). No SWR/React-Query — data is fetched manually. The current `(authenticated)/ingestion/anomaly-lab` is the intern's build wired to `/api/review/*` — **discarded and rebuilt**. `(authenticated)/catalog` has a `page.tsx` + `ProductDetailModal` — **refreshed**.

## 3. Scope

Three phases, lab-first:
- **A. Lab HTTP API** (backend, `apps/api`) — extends branch `feat/anomaly-lab-staging-gate`.
- **B. Anomaly Lab frontend** (focused triage) — `aonex-frontend`.
- **C. Catalog frontend** (refresh to new model) — `aonex-frontend`.

**Out of scope (deferred, per backend-core):** LLM-assisted auto-fill; the full anomaly-detector suite (price-anomaly + 6 informational) — so the lab gates on **completeness + identity-conflict** only; the full analytics dashboard (a basic `/queue/stats` counts query is included); CSV source.

## 4. Phase A — Lab HTTP API

New `apps/api/src/routes/anomaly-lab.ts` + `apps/api/src/handlers/anomaly-lab.ts`, mounted at `/api/lab` under the JWT-protected group; all endpoints tenant-scoped (tenantId from JWT; cross-tenant → 404, no existence leak). Handlers are thin: parse/validate input, call the `@aonex/catalog-service` domain function with `{ db, tenantId, ... }`, map results/errors to HTTP.

| Method | Path | Handler → domain | Response |
|---|---|---|---|
| GET | `/api/lab/queue?limit=&cursor=` | select `staged_products` WHERE tenant + status='pending', ORDER BY created_at, keyset paginate | `{ items: [{ stagedProductId, denormTitle, denormBrand, denormPrice, denormCurrency, sourceKind, missingFields, candidateCount, createdAt }], nextCursor }` |
| GET | `/api/lab/queue/stats` | grouped counts over pending rows | `{ total, byReason: {field: n}, bySource: {kind: n}, byAge: {today, week, older} }` |
| GET | `/api/lab/staged/:id` | select one (tenant-scoped) | `{ stagedProductId, sourceKind, sourceArtifactId, proposedIdentity, observations, missingFields, signals, matchCandidates: [{ productId, score, kind, title, brand }] }` (candidate title/brand joined from `catalog_products` for live candidates) |
| GET | `/api/lab/staged/:id/evidence` | `source_artifacts` by `sourceArtifactId` (tenant-scoped) | `{ kind: "html" \| "json", content }` — html snippet for link, raw JSON for connector |
| POST | `/api/lab/staged/:id/approve` | `promoteStagedProduct({fills})` | 200 `{ productId }`; **400** `{ stillMissing: [...] }` on `StillIncompleteError`; **409** on concurrent/non-pending; **404** cross-tenant/missing |
| POST | `/api/lab/staged/:id/reject` | `rejectStagedProduct` | 200 `{ ok: true }`; 409 if not pending |
| POST | `/api/lab/staged/:id/link` | `linkStagedProduct({confirmedProductId, fills})` | 200 `{ productId }`; **400** not-a-live-candidate; 404/409 as above |

Wiring: `composition-root.ts` constructs the handlers with `db` and mounts `/api/lab` in the protected group. The handlers import the domain fns from `@aonex/catalog-service`. **No new domain logic.**

Errors: `StillIncompleteError` → 400 with `stillMissing`; "not pending" / optimistic-lock failures → 409; not-found / wrong-tenant → 404.

## 5. Phase B — Anomaly Lab frontend (focused triage)

**API client:** add `api.lab` to `src/lib/api.ts`: `queue(limit?, cursor?)`, `queueStats()`, `getStaged(id)`, `evidence(id)`, `approve(id, fills)`, `reject(id)`, `link(id, confirmedProductId, fills)` — each a typed `request<T>` (approve/link surface the 400 `stillMissing` / 409 distinctly so the UI can react).

**Page** `(authenticated)/ingestion/anomaly-lab/page.tsx` (rebuilt) — single focused-triage view:
- **Header bar:** pending count + progress, and mini-stats by reason/source/age from `queueStats()`.
- **Center — current item form** (`StagedProductForm`): renders the canonical fields. Missing required fields (from `missingFields`) are highlighted editable inputs for the **fillable** set: `title`, `brand`, `category_path`, `identifier` (a gtin/mpn input). Present fields render read-only with a **source + confidence** badge (from `observations`). **`pricing.primary` is NOT fillable in v1** — the backend `applyFills` maps brand/gtin/mpn→identity and other keys→canonical observations but does not synthesise a pricing observation (price-fills are out of v1 scope per the backend-core spec). If `missingFields` contains `pricing.primary`, the form shows it as a **blocking read-only notice** ("missing price — cannot promote in v1; reject or wait for a priced re-ingest"), and Approve is disabled for that item (Reject/skip still work). In practice price is rarely the missing field — it's usually brand/category/identifier.
- **Side — evidence** (`EvidencePane`): `kind:"html"` → `<iframe srcDoc>`; `kind:"json"` → collapsible JSON tree.
- **Match banner** (`MatchCandidateBanner`): shown when a `matchCandidates` entry has `kind:"live"` — "Looks like ‹candidate.title›" + **Link** button → `api.lab.link`.
- **Action bar + keyboard** (`a` approve, `r` reject, `l` link, `s` skip): on success → **auto-advance** to the next queue item. `approve` 400 → re-highlight `stillMissing` fields, stay on item. 409 → toast "already resolved", advance.

**State/data:** fetch the queue once into local state; track the current index; each action POSTs then advances (`setIndex+1`), refetching the queue tail when near the end. Plain `useState`/`useEffect` + `api.lab` (matches the existing codebase; no SWR).

**Files:** `page.tsx`, `components/StagedProductForm.tsx`, `components/EvidencePane.tsx`, `components/MatchCandidateBanner.tsx`, `components/QueueStatsHeader.tsx`, `lib/lab-types.ts`. Delete the intern's `components/detail-panes/*`, `ClusterList.tsx`, `DetailPane.tsx`, old `EvidencePane.tsx`, `types.ts`.

## 6. Phase C — Catalog frontend (refresh to new model)

**API client:** ensure `api.catalog` covers: `listProducts(params)`, `getProduct(id)` (with `?consistency`), and the **new** per-attribute provenance `getAttributeProvenance(id, attributeCode)`. Remove the dead `provenance(id)` (now 410) and `sku(id)` (410) calls.

**Browse** `catalog/page.tsx`: grid/list of products (image, title, brand, primary price, status badge) with a search box + status filter (`active` / etc.). `GET /api/catalog/products`.

**Detail** `ProductDetailModal`: shows the multi-source richness — **per-channel pricing** rows (e.g. Shopify $X / Amazon $Y from `catalog_pricing_current`), **winning values** per attribute, and **per-attribute provenance** (which source won, on demand via `getAttributeProvenance`). Status + identity (gtin/brand) header.

## 7. Error handling & edge cases

- API: zod-validate bodies (reuse the existing handler pattern); tenant scope via existing JWT middleware; map domain errors to 400/404/409 as in §4.
- Lab UI: empty queue → "All clear ✅" state; network error → inline retry; approve `stillMissing` → fields re-highlighted, no advance; 409 → skip with toast.
- Catalog UI: empty/zero results → empty state; provenance fetch failure → non-fatal (detail still renders winning values).

## 8. Testing

- **API:** integration tests per endpoint (real DB, tenant-scoped): queue returns only pending tenant rows + keyset paginates; staged detail joins candidate titles; approve happy → `{productId}`, incomplete → 400 `stillMissing`, concurrent → 409; reject; link happy + not-a-live-candidate 400; cross-tenant → 404. (Mirror `apps/api` handler test conventions.)
- **Frontend:** component tests for `StagedProductForm` (missing-field inputs render; submit gathers fills), the auto-advance reducer (action → next index; 400 keeps index), `EvidencePane` (html vs json). A Playwright happy-path: queue → fill → approve → item leaves queue. Catalog: detail renders per-channel prices.

## 9. Phasing (implementation order)

1. **A. Lab API** (backend, on `feat/anomaly-lab-staging-gate`): routes + handlers + wiring + tests.
2. **B. Lab frontend**: `api.lab` client → focused-triage page + components → delete intern files → tests.
3. **C. Catalog frontend**: client provenance fix → browse → detail → tests.

Each phase is independently shippable (A is usable via API/curl before B exists; C is independent of A/B).
