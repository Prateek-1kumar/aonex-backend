# Backend refactor & handover notes

Branch `refactor/cso-handover` (on top of `feat/taxonomy-spine`). This session
executed the refactor agenda from `docs/p2-p3-summary-and-refactor-brief.md`:
SOLID convergence of the enrichment systems, a shared kernel for duplicated
primitives, the CSV adapter decomposition, and gating for the eval/seed
scripts. All repo gates are green (`bun run typecheck`, `lint`, `depcheck`
0 errors; test failures ≤ pre-refactor baseline, all pre-existing and
infra-dependent).

---

## 1. The architecture after this pass

### One enrichment system (the headline change)

`@aonex/catalog-enrichment` (archetype-based) is **deleted**. The node-schema
engine `@aonex/taxonomy-enrichment` is the single enrichment path, schema-fed
by the taxonomy spine (`node_attributes ⨝ attribute_definitions`):

```
worker catalog.product_enrich job (apps/worker/src/processors/enrich.processor.ts)
  load product (requires category_node_id — fails fast with an actionable
                message if the product isn't classified)
  → loadLeafSchemas / loadRagCorpus           (@aonex/taxonomy-schema)
  → retrieveExamples (catalog-RAG, self-excluded)
  → enrichProduct                              (@aonex/taxonomy-enrichment)
  → AUTO-APPLY `accepted` fields (valid + source-grounded + above threshold)
    as enrichment:llm observations + projectSync
  → persist everything to enrichment_proposals (status: ready); the
    `proposable` inferred remainder awaits Lab review
api apply (apps/api/src/services/enrichment-apply.ts)
  → applies ONLY human-confirmed fields (auto-applied ones are skipped),
    registers accepted candidates into attribute_definitions + the leaf's
    node_attributes, writes through the same shared observation write-path
```

Invariant preserved end-to-end: **an ungrounded fact is never written without
human review** (engine calibration `acceptInferred:false`).

Key seams:
- `@aonex/catalog-service` `appendEnrichmentObservations` /
  `removeEnrichmentObservations` — the ONE read/write/revert path for
  enrichment observations (worker + API). Composes into a caller's
  transaction via the new `DrizzleExecutor` type from `@aonex/db`.
- `PersistedProposalField` (`@aonex/types`) — the single contract for the
  rows stored in `enrichment_proposals.fields`; the worker writes it, the API
  reads it (as `Partial` for pre-migration rows), so writer/reader cannot
  drift.
- The worker caches the leaf-schema index + RAG corpus across jobs
  (`makeEnrichContextLoader`, 60s TTL, injectable for tests) — a bulk enrich
  of 50 products does NOT run 50 full-catalog scans. The corpus query
  projects only the three columns it reads (never the heavy `values` log).
- `PROTECTED_KEYS` (price/currency/inventory/identifiers) now lives in
  `@aonex/types`; `@aonex/archetypes` re-exports it. Every write-path guards on
  it.
- `enrichment_proposals.archetype` now stores the **taxonomy node id** (column
  name kept to avoid a migration + frontend change; documented in the schema).
- Persisted proposal fields keep the Lab-UI shape
  (`attributeCode/group/before/after/confidence/valid/action`) and add
  grounding metadata (`grounding/support/evidence/accepted/proposable`).

`@aonex/archetypes` remains ONLY for the catalog-service completeness/gate
scoring and the llm-extractor — it is no longer an enrichment schema source.

### Shared kernel (duplication eliminated)

- `@aonex/lib-utils` now owns: `editDistance`/`normalizedSimilarity`,
  `normalizeText`/`tokens`/`tokenSet`/`numerals`/`jaccard`/`valueToText`,
  strict GS1 GTIN validation (`gtinIssue`/`isValidGtin`/`gtinCheckDigit`), and
  the `ChatProvider` contract. taxonomy-validator/-classifier/-enrichment, the
  CSV adapter, the deduplicator and ingestion-enrichment consume or re-export
  these (no API breaks).
- **New `@aonex/taxonomy-schema`**: the canonical `loadLeafSchemas(db)`
  (formerly triplicated in scripts), `leafSchemaFor`, winning_values helpers
  (`firstScoped`/`asText`/`flattenWinningAttrs`), and the catalog-RAG corpus
  build (`loadRagCorpus`, worker + eval share it). Pure transforms + thin DB
  wrappers; unit-tested without Postgres.

### CSV adapter decomposition

`adaptGroup` (~350 lines) is now a thin composition over
`csv/group-builders.ts`: `buildParentObservations` (driven by a declarative
parent-column registry — adding a column is a data row, not code edits),
`buildParentPricing`, `buildVariants`, `buildImages`, `buildCustomAttrs`.
Each is unit-tested in isolation; all 128 pre-existing adapter tests pass
untouched.

### Correctness fixes shipped

- `coerceEnum` (taxonomy-validator) no longer fuzzes across digits or short
  strings: similarity ratio ≥ 0.75 AND identical digit sequences required.
  `"6G"` no longer silently becomes `"5G"`.
- `validateGtin` (ingestion-enrichment) now uses the strict shared validator —
  lengths 9–11 were never valid GTIN formats.
- Repo-root `bun test` no longer re-runs stale compiled suites from `dist/`
  (`bunfig.toml` → `[test] pathIgnorePatterns`).

### Scripts are gated

`scripts/` has a `tsconfig.json` and the root `typecheck` runs
`turbo run typecheck && tsc -p scripts`. ESLint already covered scripts.
The eval/seed scripts now use the canonical loaders (no local copies).

---

## 2. How to verify (operating notes)

- Gates: `bun run typecheck` · `bun run lint` · `bun run depcheck`
  (12 benign `no-orphans` warnings on type-only modules, 0 errors).
- Tests: `bun test` at the root (dist/ excluded automatically). Some suites
  need the local Postgres/seeded channels and are environment-dependent —
  they fail identically on the pre-refactor baseline.
- DB env: `set -a; . ./.env; set +a`.
- Evals:
  - `bun scripts/eval/run-taxonomy-eval.ts` — classification baseline
    (77.4% / 82.3% weighted at handover) + before-enrichment completeness.
  - `bun scripts/eval/run-enrichment-eval.ts` — P2 lift (needs LLM key;
    sequential by default because of Groq TPM limits).
  - `bun scripts/seed/classify-catalog.ts` — dry-run classification sweep.
- After a DB schema change: `cd packages/db && bun run build` (downstream
  consumes built `dist/`); same for `packages/types` / `catalog-service` if
  typecheck reports stale exports.

---

## 3. Known debts / follow-ups (carried forward)

1. **Frontend (Lab UI) polish, not blocking:** auto-applied fields appear in
   the review drawer as ordinary suggestions (the API now skips re-applying
   them). Surface the new `accepted`/`grounding` metadata as an
   "auto-applied" badge and filter them from the decision list. Candidates
   from the node-schema engine may lack `group`/`enumCandidates` (both
   optional now).
2. **CSV streaming:** the adapter still does a synchronous full-file parse;
   `MAX_CSV_ROWS` is the OOM guard. True streaming (`csv-parse` stream +
   per-row admit) is the real fix for large uploads.
3. **xlsx worker path:** still shells out to a venv Python and inlines images
   as base64 into Postgres — untouched landmine.
4. **Golden-set expansion toward ~150** + owner review of attribute
   schemas/tiers (open since P1).
5. **`enrichment_proposals.archetype` rename** to `node_id` when a migration
   window + a coordinated frontend change is convenient.
6. **Full-set P2 enrichment headline number** — still blocked on the Groq
   free-tier daily quota (the eval 429s through its retries; both env keys
   are `gsk_`). The wiring is proven (1-product smoke: 28 → 42 grounded → 56
   proposed, 100% grounding); re-run `bun scripts/eval/run-enrichment-eval.ts`
   with a funded key.

Removed as dead code (recoverable from git history): the never-wired
`apps/worker/src/services/shadow-compare.ts` (spine-vs-legacy parity utility;
nothing ever imported it). The 2-line Phase-5 stub packages under
`packages/action/` are deliberate HLD architecture markers and were kept.
