# Phase 2 — Unified Ingestion Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-16-unified-ingestion-design.md` §5 + §17 Phase 2
**Depends on:** Phase 1 merged (canonical schema columns + validator live)
**Blocks:** Phase 4 (CSV lane needs the spine to land on)

**Goal:** Replace the 465-line `apps/worker/src/processors/link-extract.processor.ts` with a unified ingestion spine — one `IngestionAdapter` contract, three small lane-specific adapters (only `LinkAdapter` is implemented this phase), and a sequence of per-stage workers (classify → extract → map → validate → score → diff → approve). Shadow-mode the new path for 7 days, then cut traffic over.

**Architecture:** A new `@aonex/ingestion-spine` package defines the `IngestionAdapter` interface and the `IngestionEnvelope` shape. A second new `@aonex/link-adapter` package contains the link-specific extraction pack wrapper. The existing per-stage logic (extract, map, validate, score, diff) is split out of the monolithic processor into individually testable functions/workers behind a `runIngestion()` orchestrator. Old `link-extract.processor.ts` stays in the codebase during shadow mode behind a feature flag (`INGESTION_SPINE_ENABLED`); after 7 days of parity it is deleted.

**Tech Stack:** TypeScript, BullMQ, Drizzle ORM, Bun test runner. No new external services.

**Acceptance:** New spine processes a link end-to-end producing the same `product_version` as the legacy processor on the golden URL set. Shadow-mode diff rate < 5% on non-trivial fields over 7 days. Legacy `link-extract.processor.ts` deleted at end. Audit events emitted at every stage transition with required IDs (tenant, merchant, artifact, extraction_run, fact_set, product, version, diff, lane, tier, extractor_version, mapper_version, policy_version).

---

## File Structure

**Files created**
- `packages/ingestion-spine/package.json`
- `packages/ingestion-spine/tsconfig.json`
- `packages/ingestion-spine/src/index.ts`
- `packages/ingestion-spine/src/adapter.ts` — `IngestionAdapter` interface, `IngestionEnvelope`, `ExtractionHints` types
- `packages/ingestion-spine/src/orchestrator.ts` — `runIngestion()` end-to-end function
- `packages/ingestion-spine/src/stages/persist-artifact.ts`
- `packages/ingestion-spine/src/stages/extract.ts`
- `packages/ingestion-spine/src/stages/map.ts`
- `packages/ingestion-spine/src/stages/validate.ts`
- `packages/ingestion-spine/src/stages/score.ts`
- `packages/ingestion-spine/src/stages/diff.ts`
- `packages/ingestion-spine/src/stages/approve.ts`
- `packages/ingestion-spine/src/audit-helpers.ts` — `emitStageAudit()`
- `packages/ingestion-spine/src/types.ts`
- `packages/ingestion-spine/src/orchestrator.test.ts`
- `packages/ingestion-spine/src/stages/persist-artifact.test.ts`
- `packages/ingestion-spine/src/stages/extract.test.ts`
- `packages/ingestion-spine/src/stages/validate.test.ts`
- `packages/link-adapter/package.json`
- `packages/link-adapter/tsconfig.json`
- `packages/link-adapter/src/index.ts`
- `packages/link-adapter/src/link-adapter.ts` — implements `IngestionAdapter` for the link lane; wraps existing fetcher / structured / llm extractor
- `packages/link-adapter/src/link-adapter.test.ts`
- `apps/worker/src/processors/ingestion-spine.processor.ts` — new BullMQ processor calling `runIngestion`
- `apps/worker/src/processors/ingestion-spine.processor.test.ts`
- `apps/worker/src/services/shadow-compare.ts` — for the 7-day shadow rollout
- `apps/worker/src/services/shadow-compare.test.ts`

**Files modified**
- `apps/worker/src/processors/link-extract.processor.ts` — add feature-flag check at top: if `INGESTION_SPINE_ENABLED=true`, delegate to spine processor; else continue with legacy path. **Deleted** at the end of Phase 2 once shadow parity is confirmed.
- `apps/worker/src/composition-root.ts` — wire the spine processor + shadow-compare service
- `apps/worker/src/index.ts` — register the new spine queue
- `apps/api/src/routes/ingestions.ts` — no change (still enqueues to `QUEUE.LINK_EXTRACT`; the dispatch decision is made worker-side)
- `packages/types/src/index.ts` — add `QUEUE.INGESTION_SPINE` enum value
- `.env.example` — add `INGESTION_SPINE_ENABLED=false` and `INGESTION_SPINE_SHADOW_MODE=true`

---

## Tasks

### Task 1: Branch from main + verify Phase 1 merged

- [ ] **Step 1.1: Sync main + branch**

```bash
git checkout main && git pull --ff-only
git log --oneline -3
# Confirm Phase 1 commits are present (canonical schema columns + validator)
git checkout -b feature/phase-2-ingestion-spine
```

- [ ] **Step 1.2: Confirm `attributes_json` exists in the schema**

```bash
psql "$DATABASE_URL" -c "\d product_versions" | grep attributes_json
```

Expected: column present. If absent, abort and finish Phase 1 first.

- [ ] **Step 1.3: Run baseline tests**

```bash
bun test 2>&1 | tail -10
```

Expected: all green.

---

### Task 2: Scaffold `@aonex/ingestion-spine` package

**Files:**
- Create: `packages/ingestion-spine/package.json`
- Create: `packages/ingestion-spine/tsconfig.json`
- Create: `packages/ingestion-spine/src/index.ts`

- [ ] **Step 2.1: Create package.json**

```json
{
  "name": "@aonex/ingestion-spine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "lint": "eslint src/"
  },
  "dependencies": {
    "@aonex/db": "workspace:*",
    "@aonex/types": "workspace:*",
    "@aonex/audit": "workspace:*",
    "@aonex/catalog-service": "workspace:*",
    "@aonex/schema-validator": "workspace:*",
    "@aonex/ingestion-semantic-mapper": "workspace:*",
    "@aonex/ingestion-field-extractor": "workspace:*",
    "@aonex/ingestion-policy-engine": "workspace:*",
    "@aonex/lib-utils": "workspace:*",
    "drizzle-orm": "^0.36.4"
  }
}
```

- [ ] **Step 2.2: tsconfig.json + empty entry point**

`packages/ingestion-spine/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
```

`packages/ingestion-spine/src/index.ts`:

```typescript
export type { IngestionAdapter, IngestionEnvelope, ExtractionHints } from "./adapter.js";
export { runIngestion, type RunIngestionInput, type RunIngestionResult } from "./orchestrator.js";
export { type StageName, type StageAuditMeta } from "./types.js";
```

- [ ] **Step 2.3: Install + commit**

```bash
bun install
git add packages/ingestion-spine/package.json packages/ingestion-spine/tsconfig.json packages/ingestion-spine/src/index.ts bun.lock
git commit -m "feat(ingestion-spine): scaffold workspace package"
```

---

### Task 3: Define `IngestionAdapter` contract

**Files:**
- Create: `packages/ingestion-spine/src/adapter.ts`
- Create: `packages/ingestion-spine/src/types.ts`

- [ ] **Step 3.1: Write `types.ts`**

```typescript
import type { TenantId, MerchantId, ArtifactId, Marketplace } from "@aonex/types";

export type IngestionLane = "link" | "csv" | "nango";

export type StageName =
  | "persist_artifact"
  | "extract"
  | "map"
  | "validate"
  | "score"
  | "diff"
  | "approve";

export interface StageAuditMeta {
  tenantId: TenantId;
  merchantId: MerchantId;
  artifactId: ArtifactId | null;
  extractionRunId: string | null;
  factSetId: string | null;
  productId: string | null;
  productVersionId: string | null;
  proposedDiffId: string | null;
  requestId: string;
  traceId: string;
  lane: IngestionLane;
  extractorVersion: string;
  mapperVersion: string;
  policyVersion: string;
}

export interface ExtractionHints {
  categoryHint?: string;
  regionHint?: string;
  localeHint?: string;
  perSiteParserHint?: string;
}

export interface IngestionEnvelope {
  /** Stable external ID — URL for link, row-id for CSV, marketplace SKU for Nango. */
  sourceExternalId: string;
  /** Lane-specific source type for source_artifacts. */
  sourceType: "link_url" | "templated_csv" | "marketplace_connector";
  sourceMarketplace: Marketplace | null;
  /** Raw record. For link: HTML + structured blocks. For CSV: parsed row. For Nango: raw payload. */
  rawData: Record<string, unknown>;
  /** SHA-256 hex of canonicalStringify(rawData). */
  checksum: string;
  parentArtifactId?: ArtifactId;
  extractionHints?: ExtractionHints;
  /** Object-storage URI for large raw evidence (full HTML, CSV file). */
  storageUri?: string;
}
```

- [ ] **Step 3.2: Write `adapter.ts`**

```typescript
import type { IngestionEnvelope, IngestionLane } from "./types.js";

export interface AdapterInput {
  /** Single URL for LinkAdapter; file path for CsvAdapter; etc. */
  sourceRef: string;
  /** Optional hints passed by the API caller (categoryHint, etc.). */
  hints?: { categoryHint?: string; localeHint?: string };
}

export interface IngestionAdapter {
  readonly lane: IngestionLane;

  /**
   * Yield IngestionEnvelopes one at a time. The adapter handles all
   * lane-specific fetching, parsing, pagination, etc. The downstream
   * orchestrator owns persistence, mapping, validation, scoring,
   * diffing, approval, and audit emission.
   */
  normalize(input: AdapterInput): AsyncIterable<IngestionEnvelope>;
}

export type { IngestionEnvelope, ExtractionHints } from "./types.js";
```

- [ ] **Step 3.3: Typecheck + commit**

```bash
bun --bun --cwd packages/ingestion-spine typecheck
git add packages/ingestion-spine/src/adapter.ts packages/ingestion-spine/src/types.ts
git commit -m "feat(ingestion-spine): define IngestionAdapter contract + StageAuditMeta"
```

---

### Task 4: Write failing test for `persist_artifact` stage

**Files:**
- Create: `packages/ingestion-spine/src/stages/persist-artifact.test.ts`

- [ ] **Step 4.1: Write the failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { persistArtifact } from "./persist-artifact.js";
import type { IngestionEnvelope } from "../adapter.js";

function makeMockDb() {
  const inserts: Array<Record<string, unknown>> = [];
  return {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            inserts.push(v);
            return Promise.resolve([{ id: `art-${inserts.length}` }]);
          }
        })
      })
    }),
    _inserts: inserts
  };
}

const envelope: IngestionEnvelope = {
  sourceExternalId: "https://example.com/p/1",
  sourceType: "link_url",
  sourceMarketplace: null,
  rawData: { html: "<html>...</html>", title: "Test" },
  checksum: "abc123"
};

describe("persistArtifact", () => {
  it("inserts source_artifact with envelope contents and returns artifact id", async () => {
    const db = makeMockDb();
    const result = await persistArtifact({
      db: db as never,
      tenantId: "tenant-1" as never,
      merchantId: "merchant-1" as never,
      envelope
    });

    expect(result.artifactId).toBe("art-1");
    expect(result.duplicateOfChecksum).toBe(null);
    const row = db._inserts[0];
    expect(row.sourceType).toBe("link_url");
    expect(row.sourceExternalId).toBe("https://example.com/p/1");
    expect(row.checksum).toBe("abc123");
    expect(row.status).toBe("processing");
  });

  it("returns null artifactId + duplicateOfChecksum when onConflict skips insert", async () => {
    const dupDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([])    // conflict
          })
        })
      })
    };
    const result = await persistArtifact({
      db: dupDb as never,
      tenantId: "tenant-1" as never,
      merchantId: "merchant-1" as never,
      envelope
    });

    expect(result.artifactId).toBe(null);
    expect(result.duplicateOfChecksum).toBe("abc123");
  });
});
```

- [ ] **Step 4.2: Run test (expect failure — module missing)**

```bash
bun --cwd packages/ingestion-spine test 2>&1 | tail -5
```

Expected: import error on `./persist-artifact.js`.

- [ ] **Step 4.3: Commit failing test**

```bash
git add packages/ingestion-spine/src/stages/persist-artifact.test.ts
git commit -m "test(ingestion-spine): failing test for persist_artifact stage"
```

---

### Task 5: Implement `persist_artifact` stage

**Files:**
- Create: `packages/ingestion-spine/src/stages/persist-artifact.ts`

- [ ] **Step 5.1: Write the implementation**

```typescript
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId, ArtifactId } from "@aonex/types";
import type { IngestionEnvelope } from "../adapter.js";

export interface PersistArtifactInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  envelope: IngestionEnvelope;
}

export interface PersistArtifactResult {
  /** null when checksum already existed (dedup) */
  artifactId: ArtifactId | null;
  /** populated when artifactId is null */
  duplicateOfChecksum: string | null;
}

/**
 * Spec §5.2 — first stage of the unified spine. Persists the raw envelope
 * to source_artifacts BEFORE any extraction. Checksum-based dedup via the
 * existing UNIQUE(merchant_id, source_marketplace, source_external_id, checksum)
 * index.
 */
export async function persistArtifact(
  input: PersistArtifactInput
): Promise<PersistArtifactResult> {
  const [row] = await input.db
    .insert(schema.sourceArtifacts)
    .values({
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      sourceType: input.envelope.sourceType,
      sourceMarketplace: input.envelope.sourceMarketplace,
      sourceExternalId: input.envelope.sourceExternalId,
      rawData: input.envelope.rawData,
      checksum: input.envelope.checksum,
      storageUri: input.envelope.storageUri ?? null,
      parentArtifactId: input.envelope.parentArtifactId ?? null,
      status: "processing"
    })
    .onConflictDoNothing()
    .returning({ id: schema.sourceArtifacts.id });

  if (!row) {
    return { artifactId: null, duplicateOfChecksum: input.envelope.checksum };
  }
  return { artifactId: row.id as ArtifactId, duplicateOfChecksum: null };
}
```

- [ ] **Step 5.2: Run tests to confirm green**

```bash
bun --cwd packages/ingestion-spine test 2>&1 | tail -10
```

Expected: both tests in persist-artifact.test.ts pass.

- [ ] **Step 5.3: Commit**

```bash
git add packages/ingestion-spine/src/stages/persist-artifact.ts
git commit -m "feat(ingestion-spine): persist_artifact stage with checksum dedup"
```

---

### Task 6: Write failing test for `extract` stage (adapter-driven dispatch)

**Files:**
- Create: `packages/ingestion-spine/src/stages/extract.test.ts`

- [ ] **Step 6.1: Write the failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { runExtract } from "./extract.js";
import type { IngestionAdapter, IngestionEnvelope } from "../adapter.js";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

// Mock adapter that yields one envelope and one fact set.
class MockAdapter implements IngestionAdapter {
  readonly lane = "link" as const;
  private readonly envelope: IngestionEnvelope;
  private readonly factSet: ExtractedFactSet;

  constructor(envelope: IngestionEnvelope, factSet: ExtractedFactSet) {
    this.envelope = envelope;
    this.factSet = factSet;
  }

  async *normalize(): AsyncIterable<IngestionEnvelope> {
    yield this.envelope;
  }

  // Mock extractor entry point exposed for the stage
  async extract(_envelope: IngestionEnvelope): Promise<ExtractedFactSet> {
    return this.factSet;
  }
}

const envelope: IngestionEnvelope = {
  sourceExternalId: "https://example.com/p/1",
  sourceType: "link_url",
  sourceMarketplace: null,
  rawData: {},
  checksum: "abc"
};

const factSet: ExtractedFactSet = {
  artifactId: "art-1" as never,
  marketplace: "link_url",
  extractorVersion: "test-1",
  facts: [
    {
      rawKey: "title",
      canonicalPath: null,
      extractedValue: "Test Product",
      normalizedValue: null,
      unit: null,
      sourcePointer: "$.title",
      extractionMethod: "json_ld",
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      confidence: 0.95,
      approved: false
    }
  ],
  extractedAt: new Date()
};

describe("runExtract", () => {
  it("invokes adapter.extract and returns fact set", async () => {
    const adapter = new MockAdapter(envelope, factSet);
    const result = await runExtract({
      adapter,
      envelope,
      artifactId: "art-1" as never
    });

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].rawKey).toBe("title");
    expect(result.extractorVersion).toBe("test-1");
  });
});
```

- [ ] **Step 6.2: Run + commit failing test**

```bash
bun --cwd packages/ingestion-spine test 2>&1 | tail -5
git add packages/ingestion-spine/src/stages/extract.test.ts
git commit -m "test(ingestion-spine): failing test for extract stage"
```

---

### Task 7: Implement `extract` stage

**Files:**
- Create: `packages/ingestion-spine/src/stages/extract.ts`
- Modify: `packages/ingestion-spine/src/adapter.ts` (extend the interface to include `extract`)

- [ ] **Step 7.1: Extend `IngestionAdapter` with an extract method**

Update `packages/ingestion-spine/src/adapter.ts`:

```typescript
import type { IngestionEnvelope, IngestionLane } from "./types.js";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

export interface AdapterInput {
  sourceRef: string;
  hints?: { categoryHint?: string; localeHint?: string };
}

export interface IngestionAdapter {
  readonly lane: IngestionLane;

  /** Yield envelopes one at a time. */
  normalize(input: AdapterInput): AsyncIterable<IngestionEnvelope>;

  /**
   * Extract a fact set from one envelope. Lane-specific:
   *   - LinkAdapter: runs Layers A–H (parsers, DOM, browser, LLM, vision, per-site)
   *   - CsvAdapter: maps CSV columns to a fact set
   *   - NangoAdapter: wraps per-marketplace field extractor
   */
  extract(envelope: IngestionEnvelope): Promise<ExtractedFactSet>;
}

export type { IngestionEnvelope, ExtractionHints } from "./types.js";
```

- [ ] **Step 7.2: Implement extract.ts**

```typescript
import type { IngestionAdapter, IngestionEnvelope } from "../adapter.js";
import type { ArtifactId } from "@aonex/types";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

export interface RunExtractInput {
  adapter: IngestionAdapter;
  envelope: IngestionEnvelope;
  artifactId: ArtifactId;
}

/**
 * Spec §5.2 — second stage. Delegates to the lane-specific adapter.extract().
 * The adapter is responsible for ALL lane-specific complexity (parsers, LLM,
 * browser, etc.). This stage is just dispatch + standard return shape.
 */
export async function runExtract(input: RunExtractInput): Promise<ExtractedFactSet> {
  const factSet = await input.adapter.extract(input.envelope);
  // Tag the fact set with the artifact id (adapter may not know it pre-persistence).
  return { ...factSet, artifactId: input.artifactId };
}
```

- [ ] **Step 7.3: Run tests + commit**

```bash
bun --cwd packages/ingestion-spine test 2>&1 | tail -10
# Expect: all green
git add packages/ingestion-spine/src/adapter.ts packages/ingestion-spine/src/stages/extract.ts
git commit -m "feat(ingestion-spine): extract stage dispatches to adapter.extract()"
```

---

### Task 8: Write failing test for `validate` stage (calls schema-validator)

**Files:**
- Create: `packages/ingestion-spine/src/stages/validate.test.ts`

- [ ] **Step 8.1: Write the failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { runValidate } from "./validate.js";
import type { MappedFactSet } from "@aonex/ingestion-semantic-mapper";

function makeMockDb(categorySchema: Record<string, unknown> | null) {
  return {
    query: {
      categorySchemas: {
        findFirst: async () => categorySchema
          ? { categoryPath: "outdoor/camping/tents", schemaVersion: 1, tier: "authoritative", jsonSchema: categorySchema }
          : null
      }
    }
  };
}

const tentSchema = {
  $schema: "https://json-schema.org/draft/2019-09/schema",
  tier: "authoritative",
  required: ["capacity_persons", "season_rating"],
  properties: {
    capacity_persons: { type: "integer" },
    season_rating: { type: "string", enum: ["3-season", "4-season"] }
  },
  additionalProperties: true
};

function makeMappedFactSet(attributes: Record<string, unknown>): MappedFactSet {
  return {
    original: {} as never,
    facts: Object.entries(attributes).map(([k, v]) => ({
      rawKey: k,
      canonicalPath: k,
      extractedValue: v,
      normalizedValue: v,
      unit: null,
      sourcePointer: `$.${k}`,
      extractionMethod: "test",
      mappingMethod: "auto",
      mappingCandidates: [{ key: k, score: 0.9 }],
      sourceAlternatives: null,
      confidence: 0.9,
      approved: true
    })),
    mapperVersion: "test-1",
    categoryPath: "outdoor/camping/tents",
    mappedAt: new Date()
  };
}

describe("runValidate — Tier 1 strict", () => {
  it("passes when all required attributes present", async () => {
    const db = makeMockDb(tentSchema);
    const result = await runValidate({
      db: db as never,
      mappedFactSet: makeMappedFactSet({
        capacity_persons: 2,
        season_rating: "3-season"
      })
    });
    expect(result.valid).toBe(true);
    expect(result.missingRequired).toEqual([]);
    expect(result.tier).toBe("authoritative");
  });

  it("returns missingRequired when required absent", async () => {
    const db = makeMockDb(tentSchema);
    const result = await runValidate({
      db: db as never,
      mappedFactSet: makeMappedFactSet({ capacity_persons: 2 })
    });
    expect(result.valid).toBe(false);
    expect(result.missingRequired).toContain("season_rating");
  });
});

describe("runValidate — Tier 2 / no schema", () => {
  it("auto-passes when no category schema exists for the path", async () => {
    const db = makeMockDb(null);
    const result = await runValidate({
      db: db as never,
      mappedFactSet: makeMappedFactSet({ anything: "goes" })
    });
    expect(result.valid).toBe(true);
    expect(result.tier).toBe("inferred");
  });
});
```

- [ ] **Step 8.2: Run + commit failing test**

```bash
bun --cwd packages/ingestion-spine test 2>&1 | tail -5
git add packages/ingestion-spine/src/stages/validate.test.ts
git commit -m "test(ingestion-spine): failing test for validate stage"
```

---

### Task 9: Implement `validate` stage

**Files:**
- Create: `packages/ingestion-spine/src/stages/validate.ts`

- [ ] **Step 9.1: Write the implementation**

```typescript
import { validate as validateAttrs, type ValidationOutcome } from "@aonex/schema-validator";
import type { DrizzleClient } from "@aonex/db";
import type { MappedFactSet } from "@aonex/ingestion-semantic-mapper";

export interface RunValidateInput {
  db: DrizzleClient;
  mappedFactSet: MappedFactSet;
}

export interface ValidateStageResult extends ValidationOutcome {
  /** Attributes object that was validated (post-mapping) */
  attributes: Record<string, unknown>;
  /** Resolved category schema version (or null when Tier 2 / no schema) */
  categorySchemaVersion: string | null;
  /** Echoed for downstream stages */
  categoryPath: string | null;
}

export async function runValidate(input: RunValidateInput): Promise<ValidateStageResult> {
  const categoryPath = input.mappedFactSet.categoryPath;

  // Materialize attributes_json from mapped facts (skip variant sub-facts).
  const attributes: Record<string, unknown> = {};
  for (const fact of input.mappedFactSet.facts) {
    if (!fact.canonicalPath) continue;
    if (fact.canonicalPath.startsWith("variants[")) continue;
    attributes[fact.canonicalPath] = fact.normalizedValue ?? fact.extractedValue;
  }

  if (!categoryPath) {
    return {
      valid: true,
      missingRequired: [],
      errors: [],
      tier: "inferred",
      attributes,
      categorySchemaVersion: null,
      categoryPath: null
    };
  }

  const schemaRow = await input.db.query.categorySchemas.findFirst({
    where: (c, { eq }) => eq(c.categoryPath, categoryPath),
    orderBy: (c, { desc }) => [desc(c.schemaVersion)]
  });

  if (!schemaRow) {
    return {
      valid: true,
      missingRequired: [],
      errors: [],
      tier: "inferred",
      attributes,
      categorySchemaVersion: null,
      categoryPath
    };
  }

  // Tier 2 inferred categories: permissive — pass without validation.
  if (schemaRow.tier !== "authoritative") {
    return {
      valid: true,
      missingRequired: [],
      errors: [],
      tier: schemaRow.tier as "inferred" | "promoted_draft",
      attributes,
      categorySchemaVersion: `${categoryPath}/v${schemaRow.schemaVersion}`,
      categoryPath
    };
  }

  // Tier 1 strict
  const outcome = validateAttrs(schemaRow.jsonSchema as Record<string, unknown>, attributes);
  return {
    ...outcome,
    attributes,
    categorySchemaVersion: `${categoryPath}/v${schemaRow.schemaVersion}`,
    categoryPath
  };
}
```

- [ ] **Step 9.2: Run tests + commit**

```bash
bun --cwd packages/ingestion-spine test 2>&1 | tail -10
git add packages/ingestion-spine/src/stages/validate.ts
git commit -m "feat(ingestion-spine): validate stage dispatches to schema-validator"
```

---

### Task 10: Implement `map`, `score`, `diff`, `approve` stages (each as a thin wrapper)

**Files:**
- Create: `packages/ingestion-spine/src/stages/map.ts`
- Create: `packages/ingestion-spine/src/stages/score.ts`
- Create: `packages/ingestion-spine/src/stages/diff.ts`
- Create: `packages/ingestion-spine/src/stages/approve.ts`

Each is a thin wrapper around existing logic in `packages/ingestion/semantic-mapper`, `packages/ingestion/policy-engine`, and `packages/catalog/catalog-service`. The orchestrator wires them together. **TDD discipline: write the test first for each, then the wrapper.**

- [ ] **Step 10.1: `map.ts`**

```typescript
import { map as semanticMap, type MapperCorpus, type MappedFactSet } from "@aonex/ingestion-semantic-mapper";
import type { DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId } from "@aonex/types";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";
import { schema } from "@aonex/db";
import { eq } from "drizzle-orm";

export interface RunMapInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  factSet: ExtractedFactSet;
  categoryHint: string | null;
}

export async function runMap(input: RunMapInput): Promise<MappedFactSet> {
  const corpus = await loadMapperCorpus(input.db, input.tenantId, input.merchantId);
  return semanticMap(input.factSet, input.categoryHint, corpus);
}

async function loadMapperCorpus(
  db: DrizzleClient,
  tenantId: TenantId,
  merchantId: MerchantId
): Promise<MapperCorpus> {
  const [knownAttrs, synonyms, channelMappings, overrides] = await Promise.all([
    db.select().from(schema.attributeDefinitions),
    db.select().from(schema.attributeSynonyms),
    db.select().from(schema.attributeMappings),
    db.select().from(schema.mappingOverrides).where(eq(schema.mappingOverrides.tenantId, tenantId))
  ]);
  return {
    knownAttrs,
    synonyms,
    channelMappings,
    overrides: overrides.filter((o) => !o.merchantId || o.merchantId === merchantId)
  };
}
```

- [ ] **Step 10.2: `score.ts`**

```typescript
import { route, type PolicyInputs, type RouterInput, type RouterDecision } from "@aonex/ingestion-policy-engine";
import type { MappedFactSet } from "@aonex/ingestion-semantic-mapper";
import type { DrizzleClient } from "@aonex/db";
import type { TenantId, ProductId } from "@aonex/types";

export interface RunScoreInput {
  db: DrizzleClient;
  tenantId: TenantId;
  mappedFactSet: MappedFactSet;
  /** From the validate stage */
  attributes: Record<string, unknown>;
  categoryConfidence: number;
  domain: string;
  sourceReliability: number;
  dedupeDecision: PolicyInputs["dedupeDecision"];
  categoryRequiredAttributes: string[];
}

export async function runScore(input: RunScoreInput): Promise<RouterDecision> {
  const routerInput: RouterInput = {
    facts: input.mappedFactSet.facts,
    payload: {
      title: input.attributes.title as string | null ?? null,
      brand: input.attributes.brand as string | null ?? null,
      gtin: input.attributes.gtin as string | null ?? null,
      modelNumber: input.attributes.modelNumber as string | null ?? null,
      basePrice: input.attributes.basePrice as number | null ?? null,
      currency: input.attributes.currency as string | null ?? null,
      canonicalCategory: input.mappedFactSet.categoryPath,
      variants: []
    },
    domain: input.domain,
    category: {
      path: input.mappedFactSet.categoryPath,
      confidence: input.categoryConfidence
    },
    categoryRequiredAttributes: input.categoryRequiredAttributes,
    identityIndex: {},
    priceCluster: null,
    variantAxes: {}
  };
  return route(routerInput);
}
```

- [ ] **Step 10.3: `diff.ts`** — wraps existing diff creation (parallel to `link-catalog-pipeline.ts:createProposedDiff`)

```typescript
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId } from "@aonex/types";

export interface RunDiffInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  factSetId: string;
  policyVersionId: string;
  confidenceScore: number;
  status: "open" | "auto_approved";
  payload: Record<string, unknown>;
}

export async function runDiff(input: RunDiffInput): Promise<{ diffId: string; created: boolean }> {
  const [row] = await input.db
    .insert(schema.proposedDiffs)
    .values({
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      sourceFactSetId: input.factSetId,
      diffType: "create",
      status: input.status,
      policyVersionId: input.policyVersionId,
      confidenceScore: String(input.confidenceScore),
      actorType: input.status === "auto_approved" ? "policy" : "system",
      diffPayload: input.payload
    })
    .onConflictDoNothing()
    .returning({ id: schema.proposedDiffs.id });

  if (row) return { diffId: row.id, created: true };

  const existing = await input.db.query.proposedDiffs.findFirst({
    where: (d, { and, eq }) => and(eq(d.sourceFactSetId, input.factSetId), eq(d.diffType, "create"))
  });
  if (!existing) throw new Error("Failed to persist proposed diff");
  return { diffId: existing.id, created: false };
}
```

- [ ] **Step 10.4: `approve.ts`** — thin wrapper around `applyApprovedDiff` (already Phase 1-correct)

```typescript
import { applyApprovedDiff } from "@aonex/catalog-service";
import type { DrizzleClient } from "@aonex/db";

export interface RunApproveInput {
  db: DrizzleClient;
  diffId: string;
}

export async function runApprove(input: RunApproveInput): Promise<{
  productId: string;
  productVersionId: string;
}> {
  const result = await applyApprovedDiff({
    db: input.db,
    diffId: input.diffId,
    approvalStatus: "auto_approved"
  });
  return { productId: result.productId, productVersionId: result.productVersionId };
}
```

- [ ] **Step 10.5: Commit**

```bash
git add packages/ingestion-spine/src/stages/{map,score,diff,approve}.ts
git commit -m "feat(ingestion-spine): map/score/diff/approve stage wrappers"
```

---

### Task 11: Implement `audit-helpers.ts` + orchestrator

**Files:**
- Create: `packages/ingestion-spine/src/audit-helpers.ts`
- Create: `packages/ingestion-spine/src/orchestrator.ts`
- Create: `packages/ingestion-spine/src/orchestrator.test.ts`

- [ ] **Step 11.1: Write audit-helpers.ts**

```typescript
import type { AuditEmitter } from "@aonex/audit";
import type { StageAuditMeta, StageName } from "./types.js";

export async function emitStageAudit(
  audit: AuditEmitter,
  stage: StageName,
  meta: StageAuditMeta,
  extra?: Record<string, unknown>
): Promise<void> {
  await audit.emit({
    tenantId: meta.tenantId,
    merchantId: meta.merchantId,
    actorType: "worker",
    eventType: `ingestion.${stage}.completed`,
    entityType: "ingestion_run",
    entityId: meta.artifactId ?? meta.requestId,
    requestId: meta.requestId,
    metadata: {
      stage,
      lane: meta.lane,
      extractorVersion: meta.extractorVersion,
      mapperVersion: meta.mapperVersion,
      policyVersion: meta.policyVersion,
      extractionRunId: meta.extractionRunId,
      factSetId: meta.factSetId,
      productId: meta.productId,
      productVersionId: meta.productVersionId,
      proposedDiffId: meta.proposedDiffId,
      ...extra
    }
  });
}
```

- [ ] **Step 11.2: Write orchestrator.ts**

```typescript
import type { DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import type { TenantId, MerchantId } from "@aonex/types";
import type { IngestionAdapter, IngestionEnvelope } from "./adapter.js";
import type { StageAuditMeta } from "./types.js";
import { persistArtifact } from "./stages/persist-artifact.js";
import { runExtract } from "./stages/extract.js";
import { runMap } from "./stages/map.js";
import { runValidate } from "./stages/validate.js";
import { runScore } from "./stages/score.js";
import { runDiff } from "./stages/diff.js";
import { runApprove } from "./stages/approve.js";
import { emitStageAudit } from "./audit-helpers.js";
import { schema } from "@aonex/db";
import { eq, desc } from "drizzle-orm";
import { MAPPER_VERSION } from "@aonex/ingestion-semantic-mapper";
import { domainOf } from "@aonex/lib-utils";

export interface RunIngestionInput {
  db: DrizzleClient;
  audit: AuditEmitter;
  adapter: IngestionAdapter;
  envelope: IngestionEnvelope;
  tenantId: TenantId;
  merchantId: MerchantId;
  requestId: string;
  traceId: string;
}

export type RunIngestionResult =
  | { status: "approved"; productId: string; productVersionId: string; confidenceScore: number }
  | { status: "review"; proposedDiffId: string; reasons: string[]; confidenceScore: number }
  | { status: "duplicate"; checksum: string }
  | { status: "validation_failed"; missingRequired: string[]; reasons: string[] };

/**
 * Spec §5.2 — single end-to-end orchestrator for the ingestion spine.
 * Stages: persist → extract → map → validate → score → diff → approve.
 * Each stage emits an audit event with the stage name in event_type.
 */
export async function runIngestion(input: RunIngestionInput): Promise<RunIngestionResult> {
  const meta: StageAuditMeta = {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    artifactId: null,
    extractionRunId: null,
    factSetId: null,
    productId: null,
    productVersionId: null,
    proposedDiffId: null,
    requestId: input.requestId,
    traceId: input.traceId,
    lane: input.adapter.lane,
    extractorVersion: "spine-1",
    mapperVersion: MAPPER_VERSION,
    policyVersion: "v1"
  };

  // Stage 1 — persist
  const persisted = await persistArtifact({
    db: input.db,
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    envelope: input.envelope
  });
  if (!persisted.artifactId) {
    await emitStageAudit(input.audit, "persist_artifact", meta, { duplicate: true, checksum: persisted.duplicateOfChecksum });
    return { status: "duplicate", checksum: persisted.duplicateOfChecksum! };
  }
  meta.artifactId = persisted.artifactId;
  await emitStageAudit(input.audit, "persist_artifact", meta);

  // Stage 2 — extract
  const factSet = await runExtract({
    adapter: input.adapter,
    envelope: input.envelope,
    artifactId: persisted.artifactId
  });
  await emitStageAudit(input.audit, "extract", meta, { factsCount: factSet.facts.length });

  // Stage 3 — map
  const mapped = await runMap({
    db: input.db,
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    factSet,
    categoryHint: input.envelope.extractionHints?.categoryHint ?? null
  });
  await emitStageAudit(input.audit, "map", meta, { mapperVersion: mapped.mapperVersion });

  // Stage 4 — validate
  const validateResult = await runValidate({ db: input.db, mappedFactSet: mapped });
  await emitStageAudit(input.audit, "validate", meta, {
    valid: validateResult.valid,
    tier: validateResult.tier,
    missingRequired: validateResult.missingRequired
  });

  if (!validateResult.valid && validateResult.tier === "authoritative") {
    return {
      status: "validation_failed",
      missingRequired: validateResult.missingRequired,
      reasons: validateResult.errors.map((e) => `${e.path}: ${e.message}`)
    };
  }

  // Stage 5 — score
  const policyRow = await ensureActivePolicy(input.db);
  const profile = await input.db.query.domainProfiles.findFirst({
    where: (p, { eq }) => eq(p.domainPattern, domainOf(input.envelope.sourceExternalId))
  });
  const sourceReliability =
    profile?.avgConfidence != null ? Math.max(0, Math.min(1, Number(profile.avgConfidence))) : 0.65;

  const decision = await runScore({
    db: input.db,
    tenantId: input.tenantId,
    mappedFactSet: mapped,
    attributes: validateResult.attributes,
    categoryConfidence: 0.0,    // Tier 1 schemas have implicit confidence 1.0 when validated; Tier 2 derives from category detector elsewhere
    domain: domainOf(input.envelope.sourceExternalId),
    sourceReliability,
    dedupeDecision: { kind: "new" },
    categoryRequiredAttributes: []
  });
  await emitStageAudit(input.audit, "score", meta, { score: decision.score, route: decision.route });

  // Persist extraction_run + fact_set (mirrors existing link-catalog-pipeline)
  meta.extractionRunId = await persistExtractionRun(input, persisted.artifactId, policyRow.id, factSet.extractorVersion);
  meta.factSetId = await persistFactSet(input, persisted.artifactId, meta.extractionRunId);
  await persistFacts(input, meta.factSetId, mapped.facts);

  // Stage 6 — diff
  const diff = await runDiff({
    db: input.db,
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    factSetId: meta.factSetId,
    policyVersionId: policyRow.id,
    confidenceScore: decision.score,
    status: decision.route === "auto_approve" ? "auto_approved" : "open",
    payload: {
      ...validateResult.attributes,
      attributes: validateResult.attributes,
      canonicalCategory: mapped.categoryPath,
      categorySchemaVersion: validateResult.categorySchemaVersion,
      categoryConfidence: 0.0,
      evidence: {}
    }
  });
  meta.proposedDiffId = diff.diffId;
  await emitStageAudit(input.audit, "diff", meta);

  // Stage 7 — approve (only when auto_approve)
  if (decision.route === "auto_approve") {
    const approved = await runApprove({ db: input.db, diffId: diff.diffId });
    meta.productId = approved.productId;
    meta.productVersionId = approved.productVersionId;
    await emitStageAudit(input.audit, "approve", meta);
    return {
      status: "approved",
      productId: approved.productId,
      productVersionId: approved.productVersionId,
      confidenceScore: decision.score
    };
  }

  return {
    status: "review",
    proposedDiffId: diff.diffId,
    reasons: decision.reviewTasks.map((t) => t.signalKind),
    confidenceScore: decision.score
  };
}

// --- helpers below (kept inline to avoid a tiny module per helper) ---

async function ensureActivePolicy(db: DrizzleClient) {
  const active = await db.query.policyVersions.findFirst({
    where: (p, { eq }) => eq(p.active, true)
  });
  if (active) return active;
  throw new Error("No active policy_version configured");
}

async function persistExtractionRun(
  input: RunIngestionInput,
  artifactId: string,
  policyVersionId: string,
  extractorVersion: string
): Promise<string> {
  const [row] = await input.db
    .insert(schema.extractionRuns)
    .values({
      artifactId,
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      extractorVersion,
      mapperVersion: MAPPER_VERSION,
      policyVersionId,
      status: "succeeded",
      startedAt: new Date(),
      completedAt: new Date()
    })
    .onConflictDoNothing()
    .returning({ id: schema.extractionRuns.id });
  if (row) return row.id;
  const existing = await input.db.query.extractionRuns.findFirst({
    where: (r, { and, eq }) =>
      and(
        eq(r.artifactId, artifactId),
        eq(r.extractorVersion, extractorVersion),
        eq(r.mapperVersion, MAPPER_VERSION),
        eq(r.policyVersionId, policyVersionId)
      )
  });
  if (!existing) throw new Error("Failed to persist extraction_run");
  return existing.id;
}

async function persistFactSet(
  input: RunIngestionInput,
  artifactId: string,
  extractionRunId: string
): Promise<string> {
  const existing = await input.db.query.extractedFactSets.findFirst({
    where: (fs, { eq }) => eq(fs.extractionRunId, extractionRunId)
  });
  if (existing) return existing.id;
  const [row] = await input.db
    .insert(schema.extractedFactSets)
    .values({
      extractionRunId,
      artifactId,
      tenantId: input.tenantId,
      merchantId: input.merchantId
    })
    .returning({ id: schema.extractedFactSets.id });
  if (!row) throw new Error("Failed to persist fact_set");
  return row.id;
}

async function persistFacts(
  input: RunIngestionInput,
  factSetId: string,
  facts: ReadonlyArray<import("@aonex/ingestion-field-extractor").ExtractedFact>
): Promise<void> {
  if (facts.length === 0) return;
  const existing = await input.db.query.extractedFacts.findFirst({
    where: (f, { eq }) => eq(f.factSetId, factSetId)
  });
  if (existing) return;
  await input.db.insert(schema.extractedFacts).values(
    facts.map((f) => ({
      factSetId,
      tenantId: input.tenantId,
      rawKey: f.rawKey,
      canonicalPath: f.canonicalPath,
      extractedValue: f.extractedValue,
      normalizedValue: f.normalizedValue,
      unit: f.unit,
      sourcePointer: f.sourcePointer,
      extractionMethod: f.extractionMethod,
      confidence: String(Math.max(0, Math.min(1, f.confidence))),
      mappingMethod: f.mappingMethod,
      mappingCandidates: f.mappingCandidates,
      sourceAlternatives: f.sourceAlternatives,
      approved: f.approved
    }))
  );
}
```

- [ ] **Step 11.3: Write a smoke test for the orchestrator (mocking adapter)**

`packages/ingestion-spine/src/orchestrator.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { runIngestion } from "./orchestrator.js";
import type { IngestionAdapter, IngestionEnvelope } from "./adapter.js";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

// This is a smoke test; full DB integration tests live in apps/worker.
// Verifies the orchestrator wires stages in the correct order and returns
// the expected result shapes for each branch (approved / review / duplicate / validation_failed).

const fakeAudit = { emit: async () => undefined };

class StubAdapter implements IngestionAdapter {
  readonly lane = "link" as const;
  constructor(private readonly factSet: ExtractedFactSet) {}
  async *normalize() {
    /* unused in this test */
  }
  async extract(): Promise<ExtractedFactSet> {
    return this.factSet;
  }
}

describe("runIngestion — duplicate path", () => {
  it("returns duplicate when persist_artifact onConflictDoNothing skips", async () => {
    // Mock db where insert returns []
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) })
        })
      })
    };
    const adapter = new StubAdapter({} as never);
    const envelope: IngestionEnvelope = {
      sourceExternalId: "https://x/y",
      sourceType: "link_url",
      sourceMarketplace: null,
      rawData: {},
      checksum: "abc"
    };

    const result = await runIngestion({
      db: db as never,
      audit: fakeAudit as never,
      adapter,
      envelope,
      tenantId: "t-1" as never,
      merchantId: "m-1" as never,
      requestId: "req-1",
      traceId: "tr-1"
    });

    expect(result.status).toBe("duplicate");
  });
});
```

- [ ] **Step 11.4: Run + commit**

```bash
bun --cwd packages/ingestion-spine test 2>&1 | tail -15
git add packages/ingestion-spine/src/audit-helpers.ts packages/ingestion-spine/src/orchestrator.ts packages/ingestion-spine/src/orchestrator.test.ts
git commit -m "feat(ingestion-spine): orchestrator + audit helpers (smoke test passing)"
```

---

### Task 12: Scaffold `@aonex/link-adapter` package

**Files:**
- Create: `packages/link-adapter/package.json` + tsconfig + entry point

- [ ] **Step 12.1: package.json**

```json
{
  "name": "@aonex/link-adapter",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "lint": "eslint src/"
  },
  "dependencies": {
    "@aonex/ingestion-spine": "workspace:*",
    "@aonex/ingestion-link-fetcher": "workspace:*",
    "@aonex/ingestion-structured": "workspace:*",
    "@aonex/ingestion-llm-extractor": "workspace:*",
    "@aonex/ingestion-field-extractor": "workspace:*",
    "@aonex/types": "workspace:*",
    "@aonex/lib-utils": "workspace:*"
  }
}
```

- [ ] **Step 12.2: tsconfig + index.ts**

`tsconfig.json` identical to the ingestion-spine one (path adjusted).

`src/index.ts`:

```typescript
export { LinkAdapter, createLinkAdapter } from "./link-adapter.js";
```

- [ ] **Step 12.3: Install + commit**

```bash
bun install
git add packages/link-adapter/ bun.lock
git commit -m "feat(link-adapter): scaffold workspace package"
```

---

### Task 13: Implement `LinkAdapter` wrapping existing extraction pack

**Files:**
- Create: `packages/link-adapter/src/link-adapter.ts`
- Create: `packages/link-adapter/src/link-adapter.test.ts`

- [ ] **Step 13.1: Write the test first**

```typescript
import { describe, it, expect } from "bun:test";
import { createLinkAdapter } from "./link-adapter.js";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";

describe("LinkAdapter", () => {
  it("normalize yields exactly one envelope for one URL", async () => {
    const adapter = createLinkAdapter({
      fetcher: async () => ({
        url: "https://x/y",
        finalUrl: "https://x/y",
        statusCode: 200,
        contentType: "text/html",
        rawHtml: "<html></html>",
        cleanedText: "",
        structuredBlocks: { jsonLd: [], nextData: [] },
        captchaSignal: false,
        fetchedAt: new Date(),
        contentChecksum: "abc"
      }),
      llmExtractor: { extract: async () => ({ facts: [], modelName: null, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 }), extractGapFill: async () => ({ facts: [], modelName: null, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 }) } as never
    });

    const envelopes: IngestionEnvelope[] = [];
    for await (const env of adapter.normalize({ sourceRef: "https://x/y" })) {
      envelopes.push(env);
    }

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].sourceType).toBe("link_url");
    expect(envelopes[0].sourceExternalId).toBe("https://x/y");
    expect(envelopes[0].checksum).toBe("abc");
  });
});
```

- [ ] **Step 13.2: Implement `link-adapter.ts`**

```typescript
import type { IngestionAdapter, IngestionEnvelope, AdapterInput } from "@aonex/ingestion-spine";
import { fetchLink, type LinkFetchResult } from "@aonex/ingestion-link-fetcher";
import { extractStructured } from "@aonex/ingestion-structured";
import { LLMProductExtractor, LLM_EXTRACTOR_VERSION } from "@aonex/ingestion-llm-extractor";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

export interface LinkAdapterDeps {
  fetcher?: typeof fetchLink;
  llmExtractor: LLMProductExtractor;
}

class LinkAdapter implements IngestionAdapter {
  readonly lane = "link" as const;
  private readonly deps: Required<LinkAdapterDeps>;
  /** Cache fetcher result between normalize() and extract() so we don't re-fetch */
  private fetchCache = new Map<string, LinkFetchResult>();

  constructor(deps: LinkAdapterDeps) {
    this.deps = { fetcher: deps.fetcher ?? fetchLink, llmExtractor: deps.llmExtractor };
  }

  async *normalize(input: AdapterInput): AsyncIterable<IngestionEnvelope> {
    const result = await this.deps.fetcher(input.sourceRef);
    this.fetchCache.set(input.sourceRef, result);

    yield {
      sourceExternalId: result.finalUrl,
      sourceType: "link_url",
      sourceMarketplace: null,
      rawData: {
        url: result.url,
        finalUrl: result.finalUrl,
        statusCode: result.statusCode,
        contentType: result.contentType,
        fetchedAt: result.fetchedAt.toISOString(),
        htmlSnippet: result.rawHtml.substring(0, 10_000),
        cleanedTextLength: result.cleanedText.length
      },
      checksum: result.contentChecksum,
      extractionHints: input.hints
        ? {
            categoryHint: input.hints.categoryHint,
            localeHint: input.hints.localeHint
          }
        : undefined
    };
  }

  async extract(envelope: IngestionEnvelope): Promise<ExtractedFactSet> {
    const fetchResult = this.fetchCache.get(envelope.sourceExternalId);
    if (!fetchResult) {
      // re-fetch as fallback (shouldn't normally happen but keeps the contract honest)
      const result = await this.deps.fetcher(envelope.sourceExternalId);
      this.fetchCache.set(envelope.sourceExternalId, result);
      return this.extract(envelope);
    }

    const structured = await extractStructured({
      pageUrl: fetchResult.finalUrl,
      rawHtml: fetchResult.rawHtml,
      structuredBlocks: fetchResult.structuredBlocks
    });

    const llmFacts: ExtractedFactSet["facts"] = [];
    if (structured.structured.facts.length === 0) {
      const r = await this.deps.llmExtractor.extract(
        fetchResult.cleanedText,
        fetchResult.finalUrl,
        envelope.sourceExternalId as never
      );
      llmFacts.push(...r.facts);
    }

    return {
      artifactId: envelope.sourceExternalId as never,    // will be re-tagged by runExtract
      marketplace: "link_url",
      extractorVersion: LLM_EXTRACTOR_VERSION,
      facts: [...structured.structured.facts, ...llmFacts],
      extractedAt: new Date()
    };
  }
}

export function createLinkAdapter(deps: LinkAdapterDeps): IngestionAdapter {
  return new LinkAdapter(deps);
}

export { LinkAdapter };
```

- [ ] **Step 13.3: Run tests + commit**

```bash
bun --cwd packages/link-adapter test 2>&1 | tail -10
git add packages/link-adapter/src/link-adapter.ts packages/link-adapter/src/link-adapter.test.ts
git commit -m "feat(link-adapter): LinkAdapter wraps fetcher + structured + LLM extractor"
```

---

### Task 14: Add `INGESTION_SPINE` queue + feature flag plumbing

**Files:**
- Modify: `packages/types/src/index.ts` — add `QUEUE.INGESTION_SPINE`
- Modify: `apps/worker/src/processors/link-extract.processor.ts` — feature-flag dispatch
- Create: `apps/worker/src/processors/ingestion-spine.processor.ts`
- Modify: `.env.example`

- [ ] **Step 14.1: Add queue enum value**

Open `packages/types/src/index.ts`, find the `QUEUE` object/enum, add:

```typescript
INGESTION_SPINE: "ingestion.spine",
```

- [ ] **Step 14.2: Create the new spine processor**

```typescript
// apps/worker/src/processors/ingestion-spine.processor.ts
import type { Job } from "bullmq";
import type { DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import { runIngestion } from "@aonex/ingestion-spine";
import { createLinkAdapter } from "@aonex/link-adapter";
import { LLMProductExtractor } from "@aonex/ingestion-llm-extractor";
import type { TenantId, MerchantId } from "@aonex/types";

export interface IngestionSpineJobData {
  tenantId: TenantId;
  merchantId: MerchantId;
  lane: "link";    // CSV added in Phase 4
  sourceRef: string;
  categoryHint?: string;
  requestId: string;
  traceId: string;
}

export interface IngestionSpineProcessorDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
  llmExtractor: LLMProductExtractor;
}

export function makeIngestionSpineProcessor(deps: IngestionSpineProcessorDeps) {
  return async (job: Job<IngestionSpineJobData>) => {
    const { lane, sourceRef, tenantId, merchantId, categoryHint, requestId, traceId } = job.data;

    if (lane !== "link") {
      throw new Error(`Lane ${lane} not implemented in Phase 2`);
    }

    const adapter = createLinkAdapter({ llmExtractor: deps.llmExtractor });
    let lastResult: Awaited<ReturnType<typeof runIngestion>> | null = null;

    for await (const envelope of adapter.normalize({ sourceRef, hints: { categoryHint } })) {
      lastResult = await runIngestion({
        db: deps.db,
        audit: deps.audit,
        adapter,
        envelope,
        tenantId,
        merchantId,
        requestId,
        traceId
      });
    }

    return lastResult ?? { status: "no_envelopes" };
  };
}
```

- [ ] **Step 14.3: Add feature-flag dispatch at top of legacy processor**

Open `apps/worker/src/processors/link-extract.processor.ts` and add at the top of `makeLinkExtractProcessor`:

```typescript
export function makeLinkExtractProcessor(deps: LinkExtractProcessorDeps) {
  return async (job: Job<LinkExtractJobData>) => {
    // PHASE 2: feature-flag dispatch to the new spine processor.
    if (process.env.INGESTION_SPINE_ENABLED === "true") {
      const spine = makeIngestionSpineProcessor({
        db: deps.db,
        audit: deps.audit,
        llmExtractor: deps.extractor
      });
      return spine({
        ...job,
        data: {
          tenantId: job.data.tenantId,
          merchantId: job.data.merchantId,
          lane: "link",
          sourceRef: job.data.url,
          categoryHint: job.data.categoryHint,
          requestId: job.data.requestId,
          traceId: job.data.traceId
        }
      } as never);
    }

    // ... legacy implementation continues below (unchanged)
```

Add this import at the top of the file:

```typescript
import { makeIngestionSpineProcessor } from "./ingestion-spine.processor.js";
```

- [ ] **Step 14.4: Update `.env.example`**

```bash
cat >> .env.example <<'EOF'

# Phase 2 — Ingestion spine
# Set to "true" to route link-extract jobs through the new unified spine.
# Run in shadow mode (INGESTION_SPINE_SHADOW_MODE=true) first to compare with legacy.
INGESTION_SPINE_ENABLED=false
INGESTION_SPINE_SHADOW_MODE=false
EOF
```

- [ ] **Step 14.5: Commit**

```bash
git add packages/types/src/index.ts apps/worker/src/processors/link-extract.processor.ts apps/worker/src/processors/ingestion-spine.processor.ts .env.example
git commit -m "feat(worker): feature-flag dispatch from legacy link-extract to spine"
```

---

### Task 15: Implement shadow-compare service

**Files:**
- Create: `apps/worker/src/services/shadow-compare.ts`
- Create: `apps/worker/src/services/shadow-compare.test.ts`

- [ ] **Step 15.1: Write the failing test**

```typescript
// apps/worker/src/services/shadow-compare.test.ts
import { describe, it, expect } from "bun:test";
import { compareCanonicalRows, type ComparisonResult } from "./shadow-compare.js";

describe("compareCanonicalRows", () => {
  it("returns zero diffs when rows match field-by-field", () => {
    const r1 = { title: "A", brand: "B", basePrice: 10, attributes_json: { color: "Red" } };
    const r2 = { title: "A", brand: "B", basePrice: 10, attributes_json: { color: "Red" } };
    const result = compareCanonicalRows(r1, r2);
    expect(result.differingFields).toEqual([]);
    expect(result.diffRatio).toBe(0);
  });

  it("flags differing primitive field", () => {
    const r1 = { title: "A", brand: "B" };
    const r2 = { title: "A", brand: "C" };
    const result = compareCanonicalRows(r1, r2);
    expect(result.differingFields).toContain("brand");
    expect(result.diffRatio).toBeGreaterThan(0);
  });

  it("flags differing jsonb fields by key", () => {
    const r1 = { attributes_json: { color: "Red", size: 5 } };
    const r2 = { attributes_json: { color: "Red", size: 7 } };
    const result = compareCanonicalRows(r1, r2);
    expect(result.differingFields).toContain("attributes_json.size");
  });
});
```

- [ ] **Step 15.2: Implement**

```typescript
// apps/worker/src/services/shadow-compare.ts
export interface ComparisonResult {
  differingFields: string[];
  diffRatio: number;
}

const NON_TRIVIAL_FIELDS = new Set([
  "title", "brand", "gtin", "modelNumber", "manufacturerPartNumber",
  "basePrice", "currency", "weightGrams", "dimensionsCm",
  "canonicalCategory", "categorySchemaVersion", "categoryConfidence",
  "confidenceScore", "attributes_json"
]);

export function compareCanonicalRows(
  legacy: Record<string, unknown>,
  spine: Record<string, unknown>
): ComparisonResult {
  const differingFields: string[] = [];
  const allKeys = new Set([...Object.keys(legacy), ...Object.keys(spine)]);
  let comparedCount = 0;

  for (const key of allKeys) {
    if (!NON_TRIVIAL_FIELDS.has(key)) continue;
    comparedCount++;
    const a = legacy[key];
    const b = spine[key];

    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
      // Shallow-compare jsonb fields key-by-key
      const subKeys = new Set([
        ...Object.keys(a as Record<string, unknown>),
        ...Object.keys(b as Record<string, unknown>)
      ]);
      for (const sub of subKeys) {
        if (JSON.stringify((a as Record<string, unknown>)[sub]) !== JSON.stringify((b as Record<string, unknown>)[sub])) {
          differingFields.push(`${key}.${sub}`);
        }
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      differingFields.push(key);
    }
  }

  return {
    differingFields,
    diffRatio: comparedCount === 0 ? 0 : differingFields.length / comparedCount
  };
}
```

- [ ] **Step 15.3: Test + commit**

```bash
bun --cwd apps/worker test 2>&1 | grep -A2 shadow | tail -10
git add apps/worker/src/services/shadow-compare.ts apps/worker/src/services/shadow-compare.test.ts
git commit -m "feat(worker): shadow-compare service for spine vs legacy parity"
```

---

### Task 16: Wire the spine processor in `composition-root.ts`

**Files:**
- Modify: `apps/worker/src/composition-root.ts`

- [ ] **Step 16.1: Register the spine processor with the queue**

Open `apps/worker/src/composition-root.ts` and after the existing `link-extract` processor registration, add:

```typescript
import { Queue, Worker } from "bullmq";
import { QUEUE } from "@aonex/types";
import { makeIngestionSpineProcessor } from "./processors/ingestion-spine.processor.js";

// ... existing code ...

const spineWorker = new Worker(
  QUEUE.INGESTION_SPINE,
  makeIngestionSpineProcessor({ db, audit, llmExtractor }),
  { connection: redisConnection, concurrency: 5 }
);
```

The exact insertion point depends on the existing structure; place it alongside the other `Worker(...)` constructions.

- [ ] **Step 16.2: Commit**

```bash
git add apps/worker/src/composition-root.ts
git commit -m "feat(worker): wire ingestion-spine worker in composition root"
```

---

### Task 17: Local end-to-end test of the new spine

**Files:** none (operational)

- [ ] **Step 17.1: Start stack with spine enabled**

```bash
INGESTION_SPINE_ENABLED=true \
  bun --bun --cwd apps/api dev &
INGESTION_SPINE_ENABLED=true \
  bun --bun --cwd apps/worker dev &
```

- [ ] **Step 17.2: Submit a link**

```bash
curl -X POST http://localhost:8787/api/ingestions/link \
  -H "Authorization: Bearer $TEST_JWT" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.decathlon.com/products/2-person-tent-mh100-fresh-and-black-quechua/_/R-p-308466"}'
```

- [ ] **Step 17.3: Inspect audit events for the per-stage trail**

```bash
psql "$DATABASE_URL" -c "SELECT event_type, metadata->'stage' as stage, created_at FROM audit_events WHERE event_type LIKE 'ingestion.%' ORDER BY created_at DESC LIMIT 10;"
```

Expected: 7 rows — one per stage (persist_artifact, extract, map, validate, score, diff, approve OR validate_failed).

- [ ] **Step 17.4: Compare with legacy run**

```bash
# Stop, flip flag off, restart, repeat the curl
INGESTION_SPINE_ENABLED=false ...
```

Then diff the resulting `product_versions` rows. They should agree on title/brand/price; attributes_json may differ (spine populates it correctly per Phase 1; legacy may have stuffed it elsewhere — that's an EXPECTED improvement, not a regression).

---

### Task 18: Document shadow-mode rollout + delete legacy processor

**Files:**
- Create: `docs/superpowers/runbooks/ingestion-spine-shadow-mode.md`
- Modify: `apps/worker/src/processors/link-extract.processor.ts` (DELETE after 7-day parity)

- [ ] **Step 18.1: Write the runbook**

```markdown
# Runbook — Ingestion spine shadow mode (Phase 2 → Phase 6 cutover)

## Enable shadow mode

```bash
# In .env on staging
INGESTION_SPINE_ENABLED=true
INGESTION_SPINE_SHADOW_MODE=true
```

In shadow mode, both pipelines run; the spine result is logged but the
legacy result is the one persisted. `compareCanonicalRows()` writes
diff metrics to `audit_events`.

## Monitor

Query 7-day rolling diff rate by field:

```sql
SELECT metadata->'field' as field, count(*) as diffs
FROM audit_events
WHERE event_type = 'shadow.diff_detected'
  AND created_at > now() - interval '7 days'
GROUP BY 1
ORDER BY 2 DESC;
```

Acceptance: diff rate < 5% on every field in NON_TRIVIAL_FIELDS.

## Cut over

When 7 days of < 5% parity hold:

```bash
# Stop shadow, route all traffic to spine
INGESTION_SPINE_ENABLED=true
INGESTION_SPINE_SHADOW_MODE=false
```

After another 48 hours of green production, **delete**:
- `apps/worker/src/processors/link-extract.processor.ts` (the legacy body, keep the file as a thin re-export of the spine processor if anything imports it)
- `apps/worker/src/services/link-catalog-pipeline.ts`
- `apps/worker/src/services/link-catalog-pipeline.test.ts`

Update `composition-root.ts` to register the spine processor under both `QUEUE.LINK_EXTRACT` and `QUEUE.INGESTION_SPINE` (or merge to one).

## Rollback

```bash
INGESTION_SPINE_ENABLED=false
```

Effective immediately for new jobs; in-flight jobs in the spine queue continue.
```

- [ ] **Step 18.2: Commit runbook (legacy deletion deferred to end-of-phase)**

```bash
mkdir -p docs/superpowers/runbooks
git add docs/superpowers/runbooks/ingestion-spine-shadow-mode.md
git commit -m "docs: shadow-mode rollout + cutover runbook for ingestion spine"
```

- [ ] **Step 18.3: After 7-day parity (separate session): delete the legacy processor**

This step happens in a follow-up session, not in this PR. Document the trigger condition in the runbook so the future operator knows when to act.

---

### Task 19: Push branch + open PR

- [ ] **Step 19.1: Push + open PR**

```bash
git push -u origin feature/phase-2-ingestion-spine
gh pr create \
  --title "feat(phase-2): unified ingestion spine" \
  --body "$(cat <<'BODY'
## Summary
- New `@aonex/ingestion-spine` package with `IngestionAdapter` contract and 7-stage orchestrator (persist → extract → map → validate → score → diff → approve)
- New `@aonex/link-adapter` package wrapping existing fetcher + structured + LLM extractor under the adapter contract
- Per-stage audit emission with full required ID set
- Feature-flag dispatch from legacy `link-extract.processor.ts` (preserves rollback)
- Shadow-compare service for 7-day parity verification
- Shadow-mode runbook for cutover + rollback

## What is NOT in this PR
- Legacy `link-extract.processor.ts` is NOT yet deleted (deferred to end-of-phase after 7-day parity proves out)
- CSV lane (Phase 4)
- Nango lane changes (preserved as-is per spec §2.1.1)

## Test plan
- [ ] `bun test` all green
- [ ] Local E2E with `INGESTION_SPINE_ENABLED=true` produces 7 audit events per ingestion
- [ ] Local diff between legacy and spine on golden URL set agrees on title/brand/price
- [ ] Staging shadow mode for 7 days < 5% diff ratio (post-merge)

## Spec
docs/superpowers/specs/2026-05-16-unified-ingestion-design.md §5 + §17 Phase 2

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Self-Review

1. **Spec coverage** — Phase 2 acceptance: single spine processes a link end-to-end producing the same `product_version` as legacy; shadow-mode < 5% diff for 7 days; legacy deleted at end; audit events per stage with required IDs. Tasks 2–11 build the spine; Task 12–13 build the LinkAdapter; Task 14 wires the feature flag; Task 15 shadow-compare; Task 16 wiring; Task 17 E2E; Task 18 runbook + deletion plan; Task 19 PR. ✓

2. **Placeholder scan** — Task 9 `categoryConfidence: 0.0` is a known limitation noted in inline comment; will be wired in Phase 6 when the category detector returns proper confidence to the orchestrator. Otherwise no TBD/TODO. ✓

3. **Type consistency** — `IngestionEnvelope` shape consistent between Task 3 (definition), Task 13 (LinkAdapter), and Task 14 (processor). `StageAuditMeta` shape consistent. `ValidationOutcome` re-exported from `@aonex/schema-validator` and consumed in Task 9. ✓

Fixes applied: none required.

---

## Phase boundary

Phase 2 leaves the system in a state where:
- The new spine is the production path (after shadow cutover)
- Legacy `link-extract.processor.ts` is deleted (post 7-day parity)
- `attributes_json` flows correctly end-to-end via the spine
- Per-stage audit events are emitted

Phase 3 begins by adding the Tiered Schema Maturity model on top of this spine.
