# P2 + P3 summary & refactor brief

Status as of the P2/P3 session (branch `feat/taxonomy-spine`, commits `5855a70` P2,
`a115f17` P3, on top of `76fbcd4` P1.5). This is the orientation for the next
session, whose goal is a **refactor + cleanup pass to make the codebase
industry-grade: SOLID, easy to test, easy to extend.** Read this, then the
project memory (`MEMORY.md` → `aonex-engagement.md`).

---

## 1. What shipped this session

### P2 — grounded, node-schema enrichment (fixes "weak enrichment")
New package **`@aonex/taxonomy-enrichment`** (pure, provider-injected; mirrors
`taxonomy-validator`/`taxonomy-classifier`). Pipeline:

```
prompt (leaf node_attributes schema + catalog-RAG few-shot)
  → model (injected ChatProvider)
  → parse (robust JSON)
  → normalize (@aonex/taxonomy-validator)
  → verify  (deterministic fact-tuple grounding, NOT the model's self-score)
  → calibrate (model × grounding × normalization → confidence)
  → result (accepted | proposable, before/after/proposed completeness)
```

Files: `src/{text,types,rag,prompt,parse,verify,calibrate,enrich,index}.ts` + tests.
Key design: **`accepted`** (source-grounded → auto-apply) is split from
**`proposable`** (confident inferences → pending Lab confirmation). An ungrounded
fact is never silently written; inferred values become review proposals. Tunable
via `CalibrationConfig` (`acceptInferred:false` default).

Eval: `scripts/eval/run-enrichment-eval.ts` runs the engine over the golden set,
streams `before → after(grounded) → proposed(+inferred)` completeness + grounding
rate. 30 unit tests; typecheck/lint/depcheck green.

**Deferred:** full-set headline number — both env keys are `gsk_` Groq keys and
the free-tier daily quota was exhausted mid-session. Proven on the products that
ran (jeans 24→71 proposed, tee 35→76, 100% grounding on auto-applied, gold 1/1).
Re-run when quota resets: `set -a; . ./.env; set +a; bun scripts/eval/run-enrichment-eval.ts`
(use `--conc 1 --max-tokens 1500`, already the defaults).

### P3 — CSV adapter hardening (fixes "weak CSV parsers")
`packages/catalog/source-adapters/src/csv/`:
- `number-parse.ts` — locale-aware decimals (European `1.234,56`, `12,5`,
  accounting `(123.45)`); replaced `cleanNumeric` which silently corrupted them.
- `gtin.ts` — GS1 **mod-10** check digit (exact 8/12/13/14); replaced length-only.
- `delimiter.ts` — quote-aware sniff across `, ; \t |` over a line sample.
- `index.ts` — per-variant pricing override, parent-field consolidation across
  the group (not row-0-only), `MAX_CSV_ROWS` guard, and a fixed pre-existing
  dead-code header-suggestion warning.
- 128 package tests pass (38 CSV incl. 6 new); worker + api typecheck clean.

---

## 2. The architecture state (and the one big tension)

The catalog-core is solid. The work this session added two clean, pure,
DI-friendly packages. The **biggest structural debt is now visible**:

> **There are TWO enrichment systems.** The OLD `@aonex/catalog-enrichment`
> (archetype-based, `resolveActiveSchema` from `@aonex/archetypes`, wired into
> the worker + the api proposal/apply flow) and the NEW `@aonex/taxonomy-enrichment`
> (node-schema-based, not yet wired anywhere but the eval). They answer the same
> question — "what attributes should this product have, and how do we fill them?"
> — from two different schema sources (archetypes vs taxonomy `node_attributes`).

Converging these is the headline refactor. The taxonomy spine is the agreed
source of truth (locked decision), so the node-schema engine should become
canonical and the archetype path retired or reduced to a compatibility shim.

The **good** extensibility patterns already in the codebase — copy these:
- `taxonomy_node_mappings`: adding a marketplace = inserting rows, not a schema
  change (Open/Closed done right).
- `attribute_definitions` registry drives schemas declaratively.
- The pure + provider-injected packages (`validator`, `classifier`, `enrichment`,
  the new csv helpers) are trivially unit-testable. Propagate this seam everywhere.

---

## 3. Refactor agenda for next session (prioritized)

### A. Converge the two enrichment systems  *(SRP / DIP — highest value)*
- Make `@aonex/taxonomy-enrichment` the canonical engine.
- Migrate the worker enrichment job + api apply flow off `@aonex/catalog-enrichment`
  / `@aonex/archetypes` and onto node-schema + the validator.
- Decide the fate of `packages/catalog/enrichment` and `packages/archetypes`
  (retire, or thin adapter). Don't leave two live paths.
- Wire enrichment into a **worker job** (model on `classify-uncategorized.ts`):
  load product → resolve leaf schema + RAG corpus → `enrichProduct` → persist
  `accepted` as observations, route `proposable` inferred to the Lab queue.

### B. Extract a shared kernel — kill the duplication  *(DRY / SRP)*
Concrete duplicates found this session:
- **`editDistance`** (Levenshtein): `taxonomy-validator/src/normalize.ts` AND
  `source-adapters/src/csv/index.ts`. → one util.
- **Text normalize/tokenize**: `taxonomy-classifier` (`tokenize`),
  `taxonomy-enrichment/src/text.ts` (`normalizeText`/`tokens`), and a third
  `norm()` inline in `scripts/eval/run-taxonomy-eval.ts`. → one util.
- **GTIN validation**: new `csv/gtin.ts` (exact-length + mod-10) vs
  `packages/ingestion/enrichment/src/sanity-validators.ts` `validateGtin`
  (looser: any length 8–14). → one shared validator (the strict one).
- **`ChatProvider`** interface: defined in BOTH `taxonomy-classifier/src/resolver.ts`
  and `taxonomy-enrichment/src/types.ts` (both structurally = `IModelProvider`).
  → one minimal shared provider contract.
- **winning_values flattening** (`firstScoped`/`asText`/`NON_ATTR`): duplicated in
  `scripts/seed/classify-catalog.ts` and `scripts/eval/run-enrichment-eval.ts`.
- **Per-leaf schema loader** (`node_attributes ⨝ attribute_definitions` →
  `AttributeSpec`/`EnrichField`): duplicated THREE times — `classify-catalog.ts`,
  `run-taxonomy-eval.ts`, `run-enrichment-eval.ts`. → a single
  `loadLeafSchemas(db)` (candidate home: a small `@aonex/taxonomy-schema` or
  extend `taxonomy-validator`).
Candidate home for primitives: `@aonex/lib-utils`.

### C. Decompose the CSV `adaptGroup` god-function  *(SRP / testability)*
`adaptGroup` in `csv/index.ts` is ~350 lines doing parent obs + pricing + variants
+ images + custom attrs inline. Split into focused, individually-tested builders:
`buildParentObservations`, `buildPricing`, `buildVariants`, `buildImages`,
`buildCustomAttrs`. The P3 helpers (`number-parse`/`gtin`/`delimiter`) are the
first step of this decomposition.
- Consider a **declarative column registry** (name → {canonical, scope, parser,
  target}) so adding a column is data, not edits to `KNOWN_CSV_COLUMNS` +
  `adaptGroup` (Open/Closed).

### D. Make the worker/api testable  *(DIP)*
Worker processors + api handlers do direct DB/LLM calls — hard to unit-test.
Introduce seams (inject `db`/`provider`/clock) like the pure packages already do,
so jobs can be tested without a live Postgres.

### E. Eval harness as a first-class, gated package
`scripts/eval/*` and `scripts/seed/*` are **not** lint/typecheck-gated and
duplicate setup (DB wiring, schema loading, golden loading). Fold the shared
pieces into a small package (or extend `@aonex/ingestion-eval`) and gate it.

---

## 4. Known correctness debts (flagged this session)

- **Validator fuzzy enum coercion is too aggressive.** `coerceEnum` (editDistance)
  coerces `"6G" → "5G"` (distance 1) — a *wrong* normalization. Move to a
  similarity-ratio threshold and/or guard against changing a leading digit/unit.
  Lives in `taxonomy-validator/src/normalize.ts`. (Surfaced by a P2 test; the P2
  calibration still rejected the value, but the validator itself is the bug.)
- **CSV is still a synchronous full-file parse.** P3 added `MAX_CSV_ROWS` as an
  OOM guard, but true streaming (`csv-parse` stream + per-row admit) is the real
  fix for large uploads.
- **The xlsx ingestion path** (worker processor) shells out to a venv Python and
  inlines images as base64 into Postgres — untouched, still a landmine.
- Single-separator ambiguity in `number-parse.ts` (`"1.234"` → 1.234) is a
  deliberate no-regression choice; revisit if per-locale hints become available.

---

## 5. Deferred / TODO carried forward
1. Full-set P2 enrichment number (Groq quota / funded key).
2. Wire enrichment into a worker job + persistence + Lab proposal queue (§3A).
3. xlsx/base64 worker landmine (§4).
4. Golden-set expansion toward ~150 + owner review of attribute schemas/tiers
   (from the P1 handoff — still open).

---

## 6. Operating notes (unchanged from P1, re-confirmed)
- DB: `set -a; . ./.env; set +a; psql "$DATABASE_URL" -c "…"`. ~308 taxonomy nodes,
  7 catalog products.
- Gates: `bun run typecheck`, `bun run lint`, `bun run depcheck` (depcheck shows
  12 benign `no-orphans` warnings on `types.ts` files, 0 errors — pre-existing).
- After a DB schema change: `cd packages/db && bun run build` (downstream consumes
  built `dist/`). NB: `taxonomy-validator/-classifier/-enrichment` are consumed
  from `src/` (`main` → `./src/index.ts`); their `dist/` is vestigial — if
  `bun test` shows a stale failure from a `dist/*.test.js`, run `bun run build`.
- Run the evals: `bun scripts/eval/run-taxonomy-eval.ts` (classification + the
  before-enrichment completeness baseline) and `bun scripts/eval/run-enrichment-eval.ts`
  (P2 lift; needs a live LLM key).
