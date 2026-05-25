# Anomaly Lab — Staging Gate (Backend Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hard-block staging gate so every ingest is routed to either the clean catalog (`writeAdapterOutput`) or a new `staged_products` holding area, with domain functions to promote/reject/link staged products into the catalog.

**Architecture:** A single new chokepoint, `admitOrStage(adapterOutput, ctx)`, runs identity resolution (now staging-aware) then a completeness gate. Confident match to a live product → enrich via existing `writeAdapterOutput` (never staged). New product that is complete → `writeAdapterOutput`. New product that is incomplete (or ambiguous identity) → `stageProduct` into `staged_products`. Both worker ingest paths call `admitOrStage` instead of `writeAdapterOutput`. Reviewer domain ops (`promoteStagedProduct`, `rejectStagedProduct`, `linkStagedProduct`) live in `catalog-service`.

**Tech Stack:** TypeScript (strict), Bun + Turbo monorepo, Drizzle ORM + Postgres, hand-written node-pg-migrate SQL migrations, `bun test`.

**Scope of THIS plan:** backend domain core only — schema, gate, staging-aware resolver, `admit-or-stage`, staging ops, worker repointing. **Out of this plan (each its own follow-on plan):** the `/api/lab` HTTP endpoints, LLM-assisted auto-fill, the full anomaly-detector suite + classification + dashboard stats, and the fresh frontend.

**Spec:** `docs/superpowers/specs/2026-05-25-anomaly-lab-staging-gate-design.md`.

**Gate scope in this plan:** blocking conditions are (a) **completeness** against `CANONICAL_MINIMUM` (computed directly by `evaluateGate`) and (b) **identity-conflict** (the resolver's existing `fuzzy_review` band, surfaced as a blocking signal). `price-anomaly` and the 6 informational detectors are deferred to the detector-suite follow-on plan — `evaluateGate` accepts a `signals` array so they slot in without a signature change.

---

## File Structure

**Create:**
- `packages/db/src/schema/staged-products.ts` — Drizzle schema for `staged_products`.
- `packages/db/migrations/0022_staged_products.sql` — ground-truth DDL (re-number if other migrations land first).
- `packages/catalog/catalog-service/src/canonical-minimum.ts` — `CANONICAL_MINIMUM` global required-field bar.
- `packages/catalog/catalog-service/src/gate/evaluate-gate.ts` — pure `evaluateGate`.
- `packages/catalog/catalog-service/src/admit-or-stage.ts` — the chokepoint orchestrator.
- `packages/catalog/catalog-service/src/staging/stage-product.ts` — insert/accumulate a staged row.
- `packages/catalog/catalog-service/src/staging/promote-staged.ts` — promote → catalog.
- `packages/catalog/catalog-service/src/staging/reject-staged.ts` — reject.
- `packages/catalog/catalog-service/src/staging/link-staged.ts` — confirm a match candidate.

**Modify:**
- `packages/db/src/schema/index.ts` — register the new schema.
- `packages/catalog/catalog-service/src/identity-resolver.ts` — add `includeStaged` mode + candidate kinds.
- `packages/catalog/catalog-service/src/catalog-write.ts` — add optional `forceProductId` to skip resolution.
- `packages/catalog/catalog-service/src/index.ts` — export the new public surface.
- `apps/worker/src/services/new-catalog-link-path.ts` — call `admitOrStage`.
- `apps/worker/src/services/new-catalog-shopify-path.ts` — call `admitOrStage`.

**Delete:**
- `packages/anomaly-lab/` — one-line stub package.

**Test (co-located, `bun test` picks up `*.test.ts`):**
- `packages/catalog/catalog-service/src/gate/evaluate-gate.test.ts`
- `packages/catalog/catalog-service/src/canonical-minimum.test.ts`
- `packages/catalog/catalog-service/src/identity-resolver.staging.test.ts`
- `packages/catalog/catalog-service/src/staging/stage-product.test.ts`
- `packages/catalog/catalog-service/src/admit-or-stage.test.ts`
- `packages/catalog/catalog-service/src/staging/promote-staged.test.ts`
- `packages/catalog/catalog-service/src/staging/reject-staged.test.ts`
- `packages/catalog/catalog-service/src/staging/link-staged.test.ts`

Integration tests that touch Postgres follow the existing catalog-service convention (a real DB via `@aonex/db` `createDb`, per-test cleanup). Where this plan shows DB-touching tests, mirror the setup already used by `catalog-write`'s tests in the same package.

---

## Task 1: `staged_products` schema + migration

**Files:**
- Create: `packages/db/migrations/0022_staged_products.sql`
- Create: `packages/db/src/schema/staged-products.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/migrations/0022_staged_products.sql`:

```sql
-- Anomaly Lab — staging gate, Task 1. Hard-block staging area.
-- Ingests that fail the catalog readiness gate land here instead of
-- catalog_products. Promoted/rejected by a human via catalog-service.
-- See docs/superpowers/specs/2026-05-25-anomaly-lab-staging-gate-design.md §6.

CREATE TABLE staged_products (
  staged_product_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  merchant_id        UUID NOT NULL,
  proposed_identity  JSONB NOT NULL DEFAULT '{}'::jsonb,
  observations       JSONB NOT NULL,           -- accumulated AdapterOutput
  denorm_title       TEXT,
  denorm_brand       TEXT,
  denorm_price       NUMERIC,
  denorm_currency    TEXT,
  source_kind        TEXT NOT NULL,            -- 'link' | 'connector:shopify' | ...
  source_artifact_id UUID,
  channel_code       TEXT,
  gate_verdict       JSONB NOT NULL,           -- { missingFields, signals }
  match_candidates   JSONB NOT NULL DEFAULT '[]'::jsonb,
  human_fills        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending|promoted|rejected
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by        UUID,
  resolved_at        TIMESTAMPTZ,
  CONSTRAINT staged_products_status_chk
    CHECK (status IN ('pending', 'promoted', 'rejected'))
);

-- Queue: pending rows for a tenant, oldest first.
CREATE INDEX idx_staged_products_tenant_status_created
  ON staged_products (tenant_id, status, created_at);

-- Reason-faceted dashboard counts (follow-on stats plan).
CREATE INDEX idx_staged_products_gate_verdict_gin
  ON staged_products USING GIN (gate_verdict);
```

- [ ] **Step 2: Run the migration up against the dev DB**

Run: `bun run db:migrate:up`
Expected: output lists `0022_staged_products` applied, no error.

- [ ] **Step 3: Write the Drizzle schema**

Create `packages/db/src/schema/staged-products.ts` (mirror the `reconciliation-overrides.ts` pattern — migration is ground truth, Drizzle is for typing):

```typescript
// Anomaly Lab — staging gate, Task 1. staged_products table.
// Hard-block holding area for ingests that fail the catalog readiness gate.
// Migration is ground truth — see migrations/0022_staged_products.sql.

import { pgTable, uuid, text, jsonb, numeric, timestamp } from "drizzle-orm/pg-core";

export const stagedProducts = pgTable("staged_products", {
  stagedProductId:  uuid("staged_product_id").primaryKey().defaultRandom(),
  tenantId:         uuid("tenant_id").notNull(),
  merchantId:       uuid("merchant_id").notNull(),
  proposedIdentity: jsonb("proposed_identity").notNull().default({}),
  observations:     jsonb("observations").notNull(),
  denormTitle:      text("denorm_title"),
  denormBrand:      text("denorm_brand"),
  denormPrice:      numeric("denorm_price"),
  denormCurrency:   text("denorm_currency"),
  sourceKind:       text("source_kind").notNull(),
  sourceArtifactId: uuid("source_artifact_id"),
  channelCode:      text("channel_code"),
  gateVerdict:      jsonb("gate_verdict").notNull(),
  matchCandidates:  jsonb("match_candidates").notNull().default([]),
  humanFills:       jsonb("human_fills").notNull().default({}),
  status:           text("status").notNull().default("pending"),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedBy:       uuid("resolved_by"),
  resolvedAt:       timestamp("resolved_at", { withTimezone: true })
});

export type StagedProduct = typeof stagedProducts.$inferSelect;
export type NewStagedProduct = typeof stagedProducts.$inferInsert;
```

- [ ] **Step 4: Register the schema**

In `packages/db/src/schema/index.ts`, add at the end of the catalog-redesign block:

```typescript
// Anomaly Lab — staging gate
export * from "./staged-products.js";
```

- [ ] **Step 5: Typecheck + commit**

Run: `bun --cwd packages/db run typecheck`
Expected: no errors.

```bash
git add packages/db/migrations/0022_staged_products.sql packages/db/src/schema/staged-products.ts packages/db/src/schema/index.ts
git commit -m "feat(db): add staged_products table for anomaly-lab staging gate"
```

---

## Task 2: `CANONICAL_MINIMUM` + `evaluateGate` (pure)

**Files:**
- Create: `packages/catalog/catalog-service/src/canonical-minimum.ts`
- Create: `packages/catalog/catalog-service/src/gate/evaluate-gate.ts`
- Test: `packages/catalog/catalog-service/src/canonical-minimum.test.ts`
- Test: `packages/catalog/catalog-service/src/gate/evaluate-gate.test.ts`

- [ ] **Step 1: Write the canonical-minimum snapshot test**

Create `packages/catalog/catalog-service/src/canonical-minimum.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { CANONICAL_MINIMUM } from "./canonical-minimum.js";

test("CANONICAL_MINIMUM is the locked v1 required-field list", () => {
  // Deliberate change required if the bar moves (spec §5.1).
  expect(CANONICAL_MINIMUM).toEqual([
    "title",
    "brand",
    "pricing.primary",
    "category_path",
    "identifier"
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun --cwd packages/catalog/catalog-service test canonical-minimum`
Expected: FAIL — cannot find module `./canonical-minimum.js`.

- [ ] **Step 3: Write `canonical-minimum.ts`**

Create `packages/catalog/catalog-service/src/canonical-minimum.ts`:

```typescript
// Anomaly Lab — staging gate. The global core minimum the catalog requires
// to be "built perfectly". Category-specific attributes are nice-to-have,
// not gating (spec §3 decision 3, §5.1).

export const CANONICAL_MINIMUM = [
  "title",          // non-empty string
  "brand",          // non-empty string
  "pricing.primary",// currency + >= 1 tier amount
  "category_path",  // non-empty
  "identifier"      // >= 1 of gtin / mpn / primary_identifier non-empty
] as const;

export type CanonicalMinimumField = (typeof CANONICAL_MINIMUM)[number];
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun --cwd packages/catalog/catalog-service test canonical-minimum`
Expected: PASS.

- [ ] **Step 5: Write the evaluateGate tests**

Create `packages/catalog/catalog-service/src/gate/evaluate-gate.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { evaluateGate, type GateInput } from "./evaluate-gate.js";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";

function obs(attributeCode: string, value: unknown): AdapterOutput["observations"][number] {
  return {
    attributeCode, target: "parent", channelCode: "web", localeCode: "_unscoped",
    source: "link", sourceRecordId: "r1", value, confidence: 1, observedAt: new Date()
  };
}

function output(over: Partial<AdapterOutput> = {}): AdapterOutput {
  return {
    observations: [obs("title", "Cool Tee"), obs("category_path", "Apparel > Tees")],
    pricingObservations: [{
      productHint: "p", channelCode: "web", locale: "_unscoped", source: "link",
      sourceRecordId: "r1", currency: "USD", tiers: [{ kind: "list", amount: 19.99 }],
      observedAt: new Date()
    }],
    inventoryObservations: [],
    identityHint: { gtin: "12345678905", brand: "Acme", titleForFuzzy: "Cool Tee", targetIsVariant: false },
    rawPayload: {},
    ...over
  };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return { adapterOutput: output(), signals: [], ...over };
}

test("complete output → admit", () => {
  const v = evaluateGate(input());
  expect(v.admit).toBe(true);
  expect(v.missingFields).toEqual([]);
});

test("missing brand + identifier → hold with those fields", () => {
  const v = evaluateGate(input({
    adapterOutput: output({
      observations: [obs("title", "Cool Tee"), obs("category_path", "Apparel > Tees")],
      identityHint: { titleForFuzzy: "Cool Tee", targetIsVariant: false }
    })
  }));
  expect(v.admit).toBe(false);
  expect(v.missingFields.sort()).toEqual(["brand", "identifier"]);
});

test("empty/whitespace title does not count as present", () => {
  const v = evaluateGate(input({
    adapterOutput: output({ observations: [obs("title", "  "), obs("category_path", "x")] })
  }));
  expect(v.missingFields).toContain("title");
});

test("a blocking signal holds an otherwise-complete product", () => {
  const v = evaluateGate(input({
    signals: [{ signalKind: "identity_conflict", severity: "high", blocking: true }]
  }));
  expect(v.admit).toBe(false);
  expect(v.blockingSignals).toHaveLength(1);
});

test("a non-blocking signal does not hold a complete product", () => {
  const v = evaluateGate(input({
    signals: [{ signalKind: "low_confidence_mapping", severity: "low", blocking: false }]
  }));
  expect(v.admit).toBe(true);
  expect(v.infoSignals).toHaveLength(1);
});
```

- [ ] **Step 6: Run to verify failure**

Run: `bun --cwd packages/catalog/catalog-service test evaluate-gate`
Expected: FAIL — cannot find module `./evaluate-gate.js`.

- [ ] **Step 7: Write `evaluate-gate.ts`**

Create `packages/catalog/catalog-service/src/gate/evaluate-gate.ts`:

```typescript
// Anomaly Lab — staging gate. Pure readiness evaluation over an AdapterOutput.
// No I/O. Blocking = completeness against CANONICAL_MINIMUM + any blocking signal.
// Spec §4, §8. `signals` is supplied by the caller (resolver + detector suite).

import type { AdapterOutput } from "@aonex/catalog-source-adapters";

export interface GateSignal {
  signalKind: string;
  severity: "low" | "medium" | "high" | "critical";
  blocking: boolean;
}

export interface GateInput {
  adapterOutput: AdapterOutput;
  signals: GateSignal[];
}

export interface GateVerdict {
  admit: boolean;
  missingFields: string[];
  blockingSignals: GateSignal[];
  infoSignals: GateSignal[];
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** Most recent observation value for an attribute code, or undefined. */
function attrValue(out: AdapterOutput, attributeCode: string): unknown {
  let latest: { observedAt: Date; value: unknown } | undefined;
  for (const o of out.observations) {
    if (o.attributeCode !== attributeCode) continue;
    if (!latest || o.observedAt > latest.observedAt) latest = o;
  }
  return latest?.value;
}

function hasPrimaryPricing(out: AdapterOutput): boolean {
  return out.pricingObservations.some(
    (p) => isNonEmptyString(p.currency) &&
      p.tiers.some((t) => typeof t.amount === "number" || typeof t.total === "number")
  );
}

function hasIdentifier(out: AdapterOutput): boolean {
  const h = out.identityHint;
  return isNonEmptyString(h.gtin) || isNonEmptyString(h.mpn) || isNonEmptyString(h.brand);
}

export function evaluateGate(input: GateInput): GateVerdict {
  const { adapterOutput: out, signals } = input;
  const missingFields: string[] = [];

  if (!isNonEmptyString(attrValue(out, "title"))) missingFields.push("title");
  if (!isNonEmptyString(out.identityHint.brand)) missingFields.push("brand");
  if (!hasPrimaryPricing(out)) missingFields.push("pricing.primary");
  if (!isNonEmptyString(attrValue(out, "category_path"))) missingFields.push("category_path");
  if (!hasIdentifier(out)) missingFields.push("identifier");

  const blockingSignals = signals.filter((s) => s.blocking);
  const infoSignals = signals.filter((s) => !s.blocking);
  const admit = missingFields.length === 0 && blockingSignals.length === 0;

  return { admit, missingFields, blockingSignals, infoSignals };
}
```

> Note: `brand` is required both as a standalone field and as one acceptable
> identifier. That is intentional — a product can satisfy `identifier` via
> gtin/mpn while still missing `brand`, and vice-versa.

- [ ] **Step 8: Run to verify pass**

Run: `bun --cwd packages/catalog/catalog-service test evaluate-gate`
Expected: PASS (all 5 cases).

- [ ] **Step 9: Commit**

```bash
git add packages/catalog/catalog-service/src/canonical-minimum.ts packages/catalog/catalog-service/src/canonical-minimum.test.ts packages/catalog/catalog-service/src/gate/
git commit -m "feat(catalog): add CANONICAL_MINIMUM + pure evaluateGate"
```

---

## Task 3: Staging-aware `resolveIdentity`

Extend the resolver to optionally search `staged_products` and tag each candidate's origin, so `admitOrStage` can tell a live match (enrich) from a staged match (accumulate) from an ambiguous one (hold + candidates).

**Files:**
- Modify: `packages/catalog/catalog-service/src/identity-resolver.ts`
- Test: `packages/catalog/catalog-service/src/identity-resolver.staging.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/catalog/catalog-service/src/identity-resolver.staging.test.ts`. Mirror the DB setup used by the existing resolver/catalog-write tests in this package (real `createDb`, insert a tenant + a `catalog_products` row + a `staged_products` row, clean up after):

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createDb, schema, type DrizzleClient } from "@aonex/db";
import { TenantId } from "@aonex/types";
import { resolveIdentity } from "./identity-resolver.js";

let db: DrizzleClient;
const TENANT = TenantId.unsafeFrom("00000000-0000-0000-0000-0000000000aa");

beforeAll(async () => {
  db = createDb();
  await db.insert(schema.catalogProducts).values({
    tenantId: TENANT, merchantId: TENANT,
    primaryIdentifier: "11111111111", identity: { gtin: "11111111111", brand: "Live" },
    status: "active", values: {}, winningValues: {}
  } as never);
  await db.insert(schema.stagedProducts).values({
    tenantId: TENANT, merchantId: TENANT,
    proposedIdentity: { gtin: "22222222222", brand: "Staged" },
    observations: {}, gateVerdict: { missingFields: ["brand"], signals: [] },
    sourceKind: "link", status: "pending"
  } as never);
});

afterAll(async () => {
  await db.delete(schema.stagedProducts).where(/* tenant cleanup */ undefined as never);
  await db.delete(schema.catalogProducts).where(/* tenant cleanup */ undefined as never);
});

test("includeStaged surfaces a staged candidate tagged kind='staged'", async () => {
  const r = await resolveIdentity({
    db, tenantId: TENANT,
    identityHint: { gtin: "22222222222" },
    includeStaged: true
  });
  expect(r.candidates.some((c) => c.kind === "staged" && c.score >= 1)).toBe(true);
});

test("live GTIN match is tagged kind='live' and resolves productId", async () => {
  const r = await resolveIdentity({
    db, tenantId: TENANT,
    identityHint: { gtin: "11111111111" },
    includeStaged: true
  });
  expect(r.matchPath).toBe("gtin");
  expect(r.productId).not.toBeNull();
  expect(r.candidates.some((c) => c.kind === "live")).toBe(true);
});

test("default (no includeStaged) ignores staged rows — backward compatible", async () => {
  const r = await resolveIdentity({
    db, tenantId: TENANT,
    identityHint: { gtin: "22222222222" }
  });
  expect(r.productId).toBeNull();
  expect(r.candidates ?? []).toEqual([]);
});
```

> Replace the `where(... undefined ...)` cleanup placeholders with the
> tenant-scoped `eq(schema.<table>.tenantId, TENANT)` delete used elsewhere in
> the package's tests. (Left explicit so the engineer wires real cleanup.)

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd packages/catalog/catalog-service test identity-resolver.staging`
Expected: FAIL — `includeStaged`/`candidates` not on the types.

- [ ] **Step 3: Extend the resolver types**

In `packages/catalog/catalog-service/src/identity-resolver.ts`, add to `IdentityResolverInput`:

```typescript
  /**
   * When true, also search staged_products (status='pending') and include
   * those matches in `candidates` tagged kind='staged'. Default false keeps
   * the resolver backward-compatible with the catalog-write path.
   */
  includeStaged?: boolean;
```

And add to `IdentityResolverResult`:

```typescript
  /**
   * All matches considered, tagged by origin. Empty unless includeStaged or
   * a live match was found. Used by admitOrStage to route the ingest.
   */
  candidates: Array<{ productId: string; score: number; kind: "live" | "staged" }>;
```

- [ ] **Step 4: Populate `candidates` on every return path**

In each `return { ... }` of `resolveIdentity` (gtin, mpn_brand, fuzzy_high, fuzzy_review, none), add a `candidates` array. For the live-match paths, include `{ productId: hit.productId, score: <strength>, kind: "live" }`. For the `none`/fuzzy paths, default `candidates: []` then append staged matches (next step). Example for the GTIN path:

```typescript
    if (hit) {
      return {
        productId: hit.productId,
        strength: 1.0,
        reviewTaskSuggested: false,
        matchPath: "gtin",
        candidateProductIds: [hit.productId],
        candidates: [{ productId: hit.productId, score: 1.0, kind: "live" }]
      };
    }
```

- [ ] **Step 5: Add the staged search**

After the live-catalog resolution logic (just before the final `none` return), add:

```typescript
  // ---- Staged search (opt-in) ------------------------------------------
  const stagedCandidates: IdentityResolverResult["candidates"] = [];
  if (input.includeStaged) {
    const gtin = identityHint.gtin;
    if (gtin) {
      const rows = await db
        .select({ id: schema.stagedProducts.stagedProductId })
        .from(schema.stagedProducts)
        .where(
          and(
            eq(schema.stagedProducts.tenantId, tenantId),
            eq(schema.stagedProducts.status, "pending"),
            sql`${schema.stagedProducts.proposedIdentity}->>'gtin' = ${gtin}`
          )
        )
        .limit(5);
      for (const r of rows) stagedCandidates.push({ productId: r.id, score: 1.0, kind: "staged" });
    }
  }
```

Then ensure the final return merges `candidates: [...stagedCandidates]` (the `none` path returns `productId: null` with these candidates so `admitOrStage` can offer an accumulate/merge).

> v1 staged matching keys on exact GTIN only — enough for the
> "Amazon-first, incomplete" dedup case. Fuzzy staged matching is a
> follow-on (detector-suite plan).

- [ ] **Step 6: Run to verify pass**

Run: `bun --cwd packages/catalog/catalog-service test identity-resolver.staging`
Expected: PASS (3 cases).

- [ ] **Step 7: Run the full package tests (no regression on catalog-write)**

Run: `bun --cwd packages/catalog/catalog-service test`
Expected: PASS — existing resolver/catalog-write tests still green (the new `candidates` field is additive).

- [ ] **Step 8: Commit**

```bash
git add packages/catalog/catalog-service/src/identity-resolver.ts packages/catalog/catalog-service/src/identity-resolver.staging.test.ts
git commit -m "feat(catalog): make resolveIdentity staging-aware with tagged candidates"
```

---

## Task 4: `stageProduct`

**Files:**
- Create: `packages/catalog/catalog-service/src/staging/stage-product.ts`
- Test: `packages/catalog/catalog-service/src/staging/stage-product.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/catalog/catalog-service/src/staging/stage-product.test.ts` (real DB, tenant-scoped cleanup as in Task 3):

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createDb, schema, type DrizzleClient } from "@aonex/db";
import { TenantId, MerchantId } from "@aonex/types";
import { eq } from "drizzle-orm";
import { stageProduct } from "./stage-product.js";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";

let db: DrizzleClient;
const TENANT = TenantId.unsafeFrom("00000000-0000-0000-0000-0000000000bb");
const MERCHANT = MerchantId.unsafeFrom("00000000-0000-0000-0000-0000000000bb");

function output(): AdapterOutput {
  return {
    observations: [{
      attributeCode: "title", target: "parent", channelCode: "web", localeCode: "_unscoped",
      source: "link", sourceRecordId: "r1", value: "Cool Tee", confidence: 1, observedAt: new Date()
    }],
    pricingObservations: [], inventoryObservations: [],
    identityHint: { titleForFuzzy: "Cool Tee", targetIsVariant: false },
    rawPayload: {}
  };
}

afterAll(async () => {
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT));
});
beforeAll(() => { db = createDb(); });

test("stageProduct inserts a pending row with verdict + denorm fields", async () => {
  const res = await stageProduct({
    db, tenantId: TENANT, merchantId: MERCHANT,
    adapterOutput: output(), sourceKind: "link", channelCode: "web",
    verdict: { admit: false, missingFields: ["brand", "identifier"], blockingSignals: [], infoSignals: [] },
    matchCandidates: []
  });
  const [row] = await db.select().from(schema.stagedProducts)
    .where(eq(schema.stagedProducts.stagedProductId, res.stagedProductId));
  expect(row?.status).toBe("pending");
  expect(row?.denormTitle).toBe("Cool Tee");
  expect((row?.gateVerdict as { missingFields: string[] }).missingFields).toContain("brand");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd packages/catalog/catalog-service test stage-product`
Expected: FAIL — cannot find module `./stage-product.js`.

- [ ] **Step 3: Write `stage-product.ts`**

```typescript
// Anomaly Lab — staging gate. Insert a gate-failed AdapterOutput into
// staged_products. Denormalises title/brand/price for the lab queue.
// Spec §6, §7.1 step 3c.

import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import type { GateVerdict } from "../gate/evaluate-gate.js";

export interface StageProductInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  adapterOutput: AdapterOutput;
  sourceKind: string;
  channelCode: string | null;
  sourceArtifactId?: string;
  verdict: GateVerdict;
  matchCandidates: Array<{ productId: string; score: number; kind: "live" | "staged" }>;
}

export interface StageProductResult { stagedProductId: string; }

function latest(out: AdapterOutput, code: string): unknown {
  let best: { observedAt: Date; value: unknown } | undefined;
  for (const o of out.observations) {
    if (o.attributeCode === code && (!best || o.observedAt > best.observedAt)) best = o;
  }
  return best?.value;
}

export async function stageProduct(input: StageProductInput): Promise<StageProductResult> {
  const { db, adapterOutput: out } = input;
  const title = latest(out, "title");
  const priceObs = out.pricingObservations[0];
  const amount = priceObs?.tiers.find((t) => typeof t.amount === "number")?.amount;

  const [row] = await db.insert(schema.stagedProducts).values({
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    proposedIdentity: out.identityHint,
    observations: out as unknown as object,
    denormTitle: typeof title === "string" ? title : null,
    denormBrand: out.identityHint.brand ?? null,
    denormPrice: typeof amount === "number" ? String(amount) : null,
    denormCurrency: priceObs?.currency ?? null,
    sourceKind: input.sourceKind,
    sourceArtifactId: input.sourceArtifactId ?? null,
    channelCode: input.channelCode,
    gateVerdict: {
      missingFields: input.verdict.missingFields,
      signals: [...input.verdict.blockingSignals, ...input.verdict.infoSignals]
    },
    matchCandidates: input.matchCandidates,
    status: "pending"
  } as never).returning({ id: schema.stagedProducts.stagedProductId });

  return { stagedProductId: row!.id };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --cwd packages/catalog/catalog-service test stage-product`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/catalog/catalog-service/src/staging/stage-product.ts packages/catalog/catalog-service/src/staging/stage-product.test.ts
git commit -m "feat(catalog): add stageProduct to persist gate-failed ingests"
```

---

## Task 5: `admitOrStage` orchestrator

**Files:**
- Create: `packages/catalog/catalog-service/src/admit-or-stage.ts`
- Test: `packages/catalog/catalog-service/src/admit-or-stage.test.ts`

- [ ] **Step 1: Write the failing integration test (routing matrix)**

Create `packages/catalog/catalog-service/src/admit-or-stage.test.ts`. Seed a tenant; assert the four routes. (Reuse the `output()` helper shape from Task 4; build complete vs incomplete variants.)

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createDb, schema, type DrizzleClient } from "@aonex/db";
import { TenantId, MerchantId } from "@aonex/types";
import { eq } from "drizzle-orm";
import { admitOrStage } from "./admit-or-stage.js";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";

let db: DrizzleClient;
const TENANT = TenantId.unsafeFrom("00000000-0000-0000-0000-0000000000cc");
const MERCHANT = MerchantId.unsafeFrom("00000000-0000-0000-0000-0000000000cc");

function complete(): AdapterOutput { /* title+brand+price+category+gtin present */
  return {
    observations: [
      { attributeCode: "title", target: "parent", channelCode: "web", localeCode: "_unscoped", source: "link", sourceRecordId: "r", value: "Tee", confidence: 1, observedAt: new Date() },
      { attributeCode: "category_path", target: "parent", channelCode: "web", localeCode: "_unscoped", source: "link", sourceRecordId: "r", value: "Apparel", confidence: 1, observedAt: new Date() }
    ],
    pricingObservations: [{ productHint: "p", channelCode: "web", locale: "_unscoped", source: "link", sourceRecordId: "r", currency: "USD", tiers: [{ kind: "list", amount: 9.99 }], observedAt: new Date() }],
    inventoryObservations: [],
    identityHint: { gtin: "30000000001", brand: "Acme", titleForFuzzy: "Tee", targetIsVariant: false },
    rawPayload: {}
  };
}
function incomplete(): AdapterOutput {
  const o = complete();
  o.identityHint = { titleForFuzzy: "Tee", targetIsVariant: false }; // drop brand + gtin
  return o;
}

beforeAll(() => { db = createDb(); });
afterAll(async () => {
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT));
  await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TENANT));
});

test("new + complete → catalog (admitted)", async () => {
  const r = await admitOrStage({ db, tenantId: TENANT, merchantId: MERCHANT, adapterOutput: complete(), sourceKind: "link", actor: "link:test", channelCode: "web" });
  expect(r.outcome).toBe("admitted");
  expect(r.productId).not.toBeNull();
});

test("new + incomplete → staged", async () => {
  const r = await admitOrStage({ db, tenantId: TENANT, merchantId: MERCHANT, adapterOutput: incomplete(), sourceKind: "link", actor: "link:test", channelCode: "web" });
  expect(r.outcome).toBe("staged");
  expect(r.stagedProductId).not.toBeNull();
});

test("incomplete ingest matching a LIVE product → enriched, not staged", async () => {
  // First admit a complete product (gtin 30000000001), then re-ingest the
  // same gtin with a missing field → should enrich, never stage.
  await admitOrStage({ db, tenantId: TENANT, merchantId: MERCHANT, adapterOutput: complete(), sourceKind: "link", actor: "link:test", channelCode: "web" });
  const second = complete();
  second.observations = second.observations.filter((o) => o.attributeCode !== "category_path");
  const r = await admitOrStage({ db, tenantId: TENANT, merchantId: MERCHANT, adapterOutput: second, sourceKind: "link", actor: "link:test", channelCode: "web" });
  expect(r.outcome).toBe("enriched");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd packages/catalog/catalog-service test admit-or-stage`
Expected: FAIL — cannot find module `./admit-or-stage.js`.

- [ ] **Step 3: Write `admit-or-stage.ts`**

```typescript
// Anomaly Lab — staging gate. The single chokepoint every ingest funnels
// through. Resolves identity (staging-aware), then either enriches a live
// product, admits a complete new product, or stages it. Spec §4.

import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId, ChannelId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import { resolveIdentity } from "./identity-resolver.js";
import { writeAdapterOutput, type WriteAdapterOutputResult } from "./catalog-write.js";
import { evaluateGate, type GateSignal } from "./gate/evaluate-gate.js";
import { stageProduct } from "./staging/stage-product.js";

export interface AdmitOrStageInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  adapterOutput: AdapterOutput;
  sourceKind: string;
  actor: string;
  channelCode: string | null;
  channelCodeToId?: Record<string, ChannelId>;
  sourceArtifactId?: string;
}

export interface AdmitOrStageResult {
  outcome: "admitted" | "enriched" | "staged";
  productId: string | null;
  stagedProductId: string | null;
}

export async function admitOrStage(input: AdmitOrStageInput): Promise<AdmitOrStageResult> {
  const { db, tenantId, merchantId, adapterOutput: out } = input;

  // 1. Resolve identity against the live catalog AND staged items.
  const resolution = await resolveIdentity({
    db, tenantId,
    identityHint: out.identityHint,
    observationTitle: out.identityHint.titleForFuzzy,
    includeStaged: true
  });

  const liveMatch = resolution.candidates.find((c) => c.kind === "live");

  // 2. Confident live match → enrichment. Updates always flow (spec dec. 4).
  if (resolution.productId && liveMatch) {
    const w = await writeAdapterOutput({
      db, tenantId, merchantId, adapterOutput: out, actor: input.actor,
      ...(input.channelCodeToId ? { channelCodeToId: input.channelCodeToId } : {})
    });
    return { outcome: "enriched", productId: w.productId, stagedProductId: null };
  }

  // 3. New product: run the gate. (Identity-conflict from the resolver's
  //    fuzzy_review band is surfaced as a blocking signal.)
  const signals: GateSignal[] = [];
  if (resolution.matchPath === "fuzzy_review" || resolution.reviewTaskSuggested) {
    signals.push({ signalKind: "identity_conflict", severity: "high", blocking: true });
  }
  const verdict = evaluateGate({ adapterOutput: out, signals });

  if (verdict.admit) {
    const w: WriteAdapterOutputResult = await writeAdapterOutput({
      db, tenantId, merchantId, adapterOutput: out, actor: input.actor,
      ...(input.channelCodeToId ? { channelCodeToId: input.channelCodeToId } : {})
    });
    return { outcome: "admitted", productId: w.productId, stagedProductId: null };
  }

  // 4. Hold in staging.
  const staged = await stageProduct({
    db, tenantId, merchantId, adapterOutput: out,
    sourceKind: input.sourceKind, channelCode: input.channelCode,
    ...(input.sourceArtifactId ? { sourceArtifactId: input.sourceArtifactId } : {}),
    verdict,
    matchCandidates: resolution.candidates
  });
  return { outcome: "staged", productId: null, stagedProductId: staged.stagedProductId };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --cwd packages/catalog/catalog-service test admit-or-stage`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/catalog/catalog-service/src/admit-or-stage.ts packages/catalog/catalog-service/src/admit-or-stage.test.ts
git commit -m "feat(catalog): add admitOrStage chokepoint (gate + route)"
```

---

## Task 6: Repoint the worker ingest paths

Both `runNewLinkCatalogPath` and `runNewShopifyCatalogPath` currently call `writeAdapterOutput` directly. Route them through `admitOrStage` so every ingest is gated.

**Files:**
- Modify: `packages/catalog/catalog-service/src/index.ts`
- Modify: `apps/worker/src/services/new-catalog-link-path.ts`
- Modify: `apps/worker/src/services/new-catalog-shopify-path.ts`

- [ ] **Step 1: Export the new surface**

In `packages/catalog/catalog-service/src/index.ts`, add:

```typescript
// ---------------------------------------------------------------------------
// Anomaly Lab — staging gate
// ---------------------------------------------------------------------------
export { admitOrStage } from "./admit-or-stage.js";
export type { AdmitOrStageInput, AdmitOrStageResult } from "./admit-or-stage.js";
export { evaluateGate } from "./gate/evaluate-gate.js";
export type { GateInput, GateVerdict, GateSignal } from "./gate/evaluate-gate.js";
export { CANONICAL_MINIMUM } from "./canonical-minimum.js";
export { stageProduct } from "./staging/stage-product.js";
export type { StageProductInput, StageProductResult } from "./staging/stage-product.js";
```

- [ ] **Step 2: Repoint the link path**

In `apps/worker/src/services/new-catalog-link-path.ts`, find the `writeAdapterOutput({ ... })` call near the end of `runNewLinkCatalogPath` and replace it with `admitOrStage`, mapping the existing args. Update the import from `@aonex/catalog-service` to include `admitOrStage`. The return type of `runNewLinkCatalogPath` changes from `WriteAdapterOutputResult` to `AdmitOrStageResult` — update the signature and any caller in `link-extract.processor.ts` that reads `.productId`/`.created` to read `.outcome`/`.productId`/`.stagedProductId`.

```typescript
// was: return writeAdapterOutput({ db, tenantId, merchantId, adapterOutput, actor: "link:processor", channelCodeToId });
return admitOrStage({
  db, tenantId, merchantId, adapterOutput,
  sourceKind: "link",
  actor: "link:processor",
  channelCode,                              // already in scope in this fn
  ...(channelCodeToId ? { channelCodeToId } : {}),
  ...(artifactId ? { sourceArtifactId: artifactId } : {})
});
```

> Check `new-catalog-link-path.ts` for the exact local variable names
> (`channelCode`, `artifactId`, and whether a `channelCodeToId` map is built);
> use whatever the function already has in scope. If `channelCodeToId` isn't
> built here, omit it — pricing observations are only present when the channel
> resolved.

- [ ] **Step 3: Repoint the shopify path**

In `apps/worker/src/services/new-catalog-shopify-path.ts`, same edit: replace the `writeAdapterOutput` call in `runNewShopifyCatalogPath` with `admitOrStage` using `sourceKind: "connector:shopify"`, `actor: "shopify:connector"`, the in-scope `channelCode` and `channelCodeToId`. Update the return type + the drain processor's per-record reader accordingly (it currently swallows/warns per record — keep that, just read `.outcome`).

- [ ] **Step 4: Typecheck the worker + catalog-service**

Run: `bun --cwd packages/catalog/catalog-service run typecheck && bun --cwd apps/worker run typecheck`
Expected: no errors. (Fix any caller that read `.created`/`.productId` to handle the `staged` outcome.)

- [ ] **Step 5: Run worker + catalog tests**

Run: `bun --cwd apps/worker test && bun --cwd packages/catalog/catalog-service test`
Expected: PASS. Update any existing worker test that asserted a catalog write always happens for incomplete fixtures — those fixtures now stage. (If a fixture was incomplete and the test asserted a catalog row, either make the fixture complete or assert `outcome: "staged"`.)

- [ ] **Step 6: Commit**

```bash
git add packages/catalog/catalog-service/src/index.ts apps/worker/src/services/new-catalog-link-path.ts apps/worker/src/services/new-catalog-shopify-path.ts apps/worker/src/processors/
git commit -m "feat(worker): route link + shopify ingests through admitOrStage gate"
```

---

## Task 7: `writeAdapterOutput` `forceProductId` (for link-to-existing)

Promotion sometimes needs to attach to a *specific* product the reviewer confirmed (a fuzzy match with no shared GTIN). Add an optional `forceProductId` that skips identity resolution.

**Files:**
- Modify: `packages/catalog/catalog-service/src/catalog-write.ts`
- Test: `packages/catalog/catalog-service/src/catalog-write.force-id.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/catalog/catalog-service/src/catalog-write.force-id.test.ts`: seed a `catalog_products` row P with an unrelated identity; call `writeAdapterOutput` with `forceProductId: P` and an AdapterOutput whose hint would NOT resolve to P; assert the observations land on P (`result.productId === P`, `created === false`).

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createDb, schema, type DrizzleClient } from "@aonex/db";
import { TenantId, MerchantId } from "@aonex/types";
import { eq } from "drizzle-orm";
import { writeAdapterOutput } from "./catalog-write.js";

let db: DrizzleClient;
const TENANT = TenantId.unsafeFrom("00000000-0000-0000-0000-0000000000dd");
const MERCHANT = MerchantId.unsafeFrom("00000000-0000-0000-0000-0000000000dd");
let pid: string;

beforeAll(async () => {
  db = createDb();
  const [row] = await db.insert(schema.catalogProducts).values({
    tenantId: TENANT, merchantId: MERCHANT, primaryIdentifier: "force-p",
    identity: {}, status: "active", values: {}, winningValues: {}
  } as never).returning({ id: schema.catalogProducts.productId });
  pid = row!.id;
});
afterAll(async () => {
  await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TENANT));
});

test("forceProductId attaches observations to the given product, skipping resolution", async () => {
  const r = await writeAdapterOutput({
    db, tenantId: TENANT, merchantId: MERCHANT, actor: "manual:lab",
    forceProductId: pid,
    adapterOutput: {
      observations: [{ attributeCode: "title", target: "parent", channelCode: "web", localeCode: "_unscoped", source: "manual:lab", sourceRecordId: "x", value: "Forced", confidence: 1, observedAt: new Date() }],
      pricingObservations: [], inventoryObservations: [],
      identityHint: { titleForFuzzy: "Totally Different", targetIsVariant: false },
      rawPayload: {}
    }
  });
  expect(r.productId).toBe(pid);
  expect(r.created).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd packages/catalog/catalog-service test catalog-write.force-id`
Expected: FAIL — `forceProductId` not on `WriteAdapterOutputInput`.

- [ ] **Step 3: Add `forceProductId` to the input type + resolution short-circuit**

In `WriteAdapterOutputInput` add:

```typescript
  /**
   * Skip identity resolution and attach observations to this existing
   * product_id. Used by the anomaly-lab "link to existing" promotion path
   * when a reviewer has confirmed the match. The product MUST already exist
   * and belong to `tenantId`.
   */
  forceProductId?: string;
```

In `catalog-write.ts`, locate the `resolveIdentity({...})` call and wrap it:

```typescript
const resolution = input.forceProductId
  ? { productId: input.forceProductId, strength: 1, reviewTaskSuggested: false, matchPath: "gtin" as const, candidateProductIds: [input.forceProductId], candidates: [{ productId: input.forceProductId, score: 1, kind: "live" as const }] }
  : await resolveIdentity({ /* ...existing args... */ });
```

Keep the existing downstream logic (it branches on `resolution.productId` being non-null → existing product, no new insert). The forced path yields `created: false`.

- [ ] **Step 4: Run to verify pass**

Run: `bun --cwd packages/catalog/catalog-service test catalog-write.force-id`
Expected: PASS.

- [ ] **Step 5: Full package test (no regression)**

Run: `bun --cwd packages/catalog/catalog-service test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/catalog/catalog-service/src/catalog-write.ts packages/catalog/catalog-service/src/catalog-write.force-id.test.ts
git commit -m "feat(catalog): add writeAdapterOutput forceProductId for lab link-to-existing"
```

---

## Task 8: `promoteStagedProduct`

**Files:**
- Create: `packages/catalog/catalog-service/src/staging/promote-staged.ts`
- Test: `packages/catalog/catalog-service/src/staging/promote-staged.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/catalog/catalog-service/src/staging/promote-staged.test.ts`: stage an incomplete product (via `stageProduct`), then `promoteStagedProduct` with `fills` that satisfy the minimum; assert (a) a `catalog_products` row now exists, (b) `reconciliation_overrides` pins were written for each fill with `actor='manual:lab'`, (c) the staged row is `status='promoted'`. Also a negative case: promoting with still-incomplete fills throws / returns `stillMissing` and leaves status `pending` with no pins.

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createDb, schema, type DrizzleClient } from "@aonex/db";
import { TenantId, MerchantId } from "@aonex/types";
import { eq } from "drizzle-orm";
import { stageProduct } from "./stage-product.js";
import { promoteStagedProduct, StillIncompleteError } from "./promote-staged.js";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";

let db: DrizzleClient;
const TENANT = TenantId.unsafeFrom("00000000-0000-0000-0000-0000000000ee");
const MERCHANT = MerchantId.unsafeFrom("00000000-0000-0000-0000-0000000000ee");
const USER = "00000000-0000-0000-0000-0000000000e1";

function incomplete(): AdapterOutput {
  return {
    observations: [
      { attributeCode: "title", target: "parent", channelCode: "web", localeCode: "_unscoped", source: "link", sourceRecordId: "r", value: "Tee", confidence: 1, observedAt: new Date() },
      { attributeCode: "category_path", target: "parent", channelCode: "web", localeCode: "_unscoped", source: "link", sourceRecordId: "r", value: "Apparel", confidence: 1, observedAt: new Date() }
    ],
    pricingObservations: [{ productHint: "p", channelCode: "web", locale: "_unscoped", source: "link", sourceRecordId: "r", currency: "USD", tiers: [{ kind: "list", amount: 9.99 }], observedAt: new Date() }],
    inventoryObservations: [],
    identityHint: { titleForFuzzy: "Tee", targetIsVariant: false }, // no brand / gtin
    rawPayload: {}
  };
}

beforeAll(() => { db = createDb(); });
afterAll(async () => {
  await db.delete(schema.reconciliationOverrides).where(/* via product join — see note */ undefined as never);
  await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TENANT));
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT));
});

test("promote with satisfying fills → catalog row + pins + status promoted", async () => {
  const { stagedProductId } = await stageProduct({
    db, tenantId: TENANT, merchantId: MERCHANT, adapterOutput: incomplete(),
    sourceKind: "link", channelCode: "web",
    verdict: { admit: false, missingFields: ["brand", "identifier"], blockingSignals: [], infoSignals: [] },
    matchCandidates: []
  });

  const r = await promoteStagedProduct({
    db, tenantId: TENANT, stagedProductId, resolvedBy: USER,
    fills: { brand: "Acme", gtin: "40000000001" }
  });

  expect(r.productId).not.toBeNull();
  const [staged] = await db.select().from(schema.stagedProducts).where(eq(schema.stagedProducts.stagedProductId, stagedProductId));
  expect(staged?.status).toBe("promoted");
  const pins = await db.select().from(schema.reconciliationOverrides).where(eq(schema.reconciliationOverrides.productId, r.productId!));
  expect(pins.length).toBeGreaterThanOrEqual(2);
  expect(pins.every((p) => p.actor === "manual:lab")).toBe(true);
});

test("promote that stays incomplete throws StillIncompleteError, writes no pins, stays pending", async () => {
  const { stagedProductId } = await stageProduct({
    db, tenantId: TENANT, merchantId: MERCHANT, adapterOutput: incomplete(),
    sourceKind: "link", channelCode: "web",
    verdict: { admit: false, missingFields: ["brand", "identifier"], blockingSignals: [], infoSignals: [] },
    matchCandidates: []
  });
  let err: unknown;
  try {
    await promoteStagedProduct({ db, tenantId: TENANT, stagedProductId, resolvedBy: USER, fills: { /* still no brand */ } });
  } catch (e) { err = e; }
  expect(err).toBeInstanceOf(StillIncompleteError);
  const [staged] = await db.select().from(schema.stagedProducts).where(eq(schema.stagedProducts.stagedProductId, stagedProductId));
  expect(staged?.status).toBe("pending");
});
```

> The pin-cleanup `delete` needs a product-scoped predicate (pins FK to
> `catalog_products`, cascade on product delete). Deleting the catalog rows
> first (cascade) removes the pins — so the explicit override delete can be
> dropped; left as a reminder.

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd packages/catalog/catalog-service test promote-staged`
Expected: FAIL — cannot find module `./promote-staged.js`.

- [ ] **Step 3: Write `promote-staged.ts`**

```typescript
// Anomaly Lab — staging gate. Promote a staged product into the catalog.
// Applies reviewer fills as reconciliation_overrides pins + synthetic
// manual:lab observations, re-runs the gate (defence in depth), then
// writeAdapterOutput. Spec §7.1 step 6.

import { eq, and } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import { writeAdapterOutput } from "../catalog-write.js";
import { evaluateGate } from "../gate/evaluate-gate.js";

export class StillIncompleteError extends Error {
  constructor(public readonly stillMissing: string[]) {
    super(`Still missing required fields: ${stillMissing.join(", ")}`);
    this.name = "StillIncompleteError";
  }
}

/** Map a CANONICAL_MINIMUM fill key to its applied form on the AdapterOutput. */
function applyFills(out: AdapterOutput, fills: Record<string, unknown>, now: Date): AdapterOutput {
  const next: AdapterOutput = structuredClone(out);
  const synth = (attributeCode: string, value: unknown) => next.observations.push({
    attributeCode, target: "parent", channelCode: "web", localeCode: "_unscoped",
    source: "manual:lab", sourceRecordId: "lab-fill", value, confidence: 1, observedAt: now
  });
  for (const [k, v] of Object.entries(fills)) {
    if (k === "brand") next.identityHint.brand = String(v);
    else if (k === "gtin") next.identityHint.gtin = String(v);
    else if (k === "mpn") next.identityHint.mpn = String(v);
    else if (k === "title") synth("title", v);
    else if (k === "category_path") synth("category_path", v);
    // pricing fills handled by callers that supply pricingObservations;
    // out of v1 fill scope (price is rarely the missing field).
  }
  return next;
}

export interface PromoteStagedInput {
  db: DrizzleClient;
  tenantId: TenantId;
  stagedProductId: string;
  resolvedBy: string;
  fills: Record<string, unknown>;
  /** Confirmed live product to attach to (from link action). */
  confirmedMatchProductId?: string;
}

export interface PromoteStagedResult { productId: string | null; }

export async function promoteStagedProduct(input: PromoteStagedInput): Promise<PromoteStagedResult> {
  const { db, tenantId, stagedProductId, fills } = input;
  const now = new Date();

  return db.transaction(async (tx) => {
    const [staged] = await tx.select().from(schema.stagedProducts)
      .where(and(eq(schema.stagedProducts.stagedProductId, stagedProductId), eq(schema.stagedProducts.tenantId, tenantId)))
      .for("update");
    if (!staged || staged.status !== "pending") {
      throw new Error(`staged product ${stagedProductId} not pending`);
    }

    const baseOutput = staged.observations as unknown as AdapterOutput;
    const filled = applyFills(baseOutput, fills, now);

    const verdict = evaluateGate({ adapterOutput: filled, signals: [] });
    if (!verdict.admit) throw new StillIncompleteError(verdict.missingFields);

    const w = await writeAdapterOutput({
      db: tx as unknown as DrizzleClient,
      tenantId,
      merchantId: staged.merchantId as never,
      adapterOutput: filled,
      actor: "manual:lab",
      ...(input.confirmedMatchProductId ? { forceProductId: input.confirmedMatchProductId } : {})
    });

    // Pin every human-supplied field so future ingests can't overwrite it.
    for (const [k, v] of Object.entries(fills)) {
      await tx.insert(schema.reconciliationOverrides).values({
        productId: w.productId,
        attributeCode: k,
        channelCode: "_unscoped",
        localeCode: "_unscoped",
        frozenValue: v as never,
        actor: "manual:lab",
        rationale: `anomaly-lab promotion of staged ${stagedProductId} by ${input.resolvedBy}`
      } as never);
    }

    await tx.update(schema.stagedProducts)
      .set({ status: "promoted", resolvedBy: input.resolvedBy, resolvedAt: now, humanFills: fills as never, updatedAt: now })
      .where(eq(schema.stagedProducts.stagedProductId, stagedProductId));

    return { productId: w.productId };
  });
}
```

> `writeAdapterOutput` accepts `db: DrizzleClient`; inside the transaction we
> pass `tx`. Confirm the existing catalog-write tests already exercise it
> within a `db.transaction` (the function is written to run "in one
> transaction"); if it opens its own transaction internally, pass `db`
> instead of `tx` and drop the outer `db.transaction` wrapper, moving the pin
> writes + status update to run after `writeAdapterOutput` returns. Pick
> whichever matches the actual implementation and keep all writes atomic.

- [ ] **Step 4: Run to verify pass**

Run: `bun --cwd packages/catalog/catalog-service test promote-staged`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/catalog/catalog-service/src/staging/promote-staged.ts packages/catalog/catalog-service/src/staging/promote-staged.test.ts
git commit -m "feat(catalog): add promoteStagedProduct (pins + gate re-check + write)"
```

---

## Task 9: `rejectStagedProduct` + `linkStagedProduct`

**Files:**
- Create: `packages/catalog/catalog-service/src/staging/reject-staged.ts`
- Create: `packages/catalog/catalog-service/src/staging/link-staged.ts`
- Test: `packages/catalog/catalog-service/src/staging/reject-staged.test.ts`
- Test: `packages/catalog/catalog-service/src/staging/link-staged.test.ts`

- [ ] **Step 1: Write the reject test**

Create `packages/catalog/catalog-service/src/staging/reject-staged.test.ts`: stage a product, `rejectStagedProduct`, assert `status='rejected'` + `resolved_by/at` set + no `catalog_products` row created.

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createDb, schema, type DrizzleClient } from "@aonex/db";
import { TenantId, MerchantId } from "@aonex/types";
import { eq } from "drizzle-orm";
import { stageProduct } from "./stage-product.js";
import { rejectStagedProduct } from "./reject-staged.js";

let db: DrizzleClient;
const TENANT = TenantId.unsafeFrom("00000000-0000-0000-0000-0000000000ff");
const MERCHANT = MerchantId.unsafeFrom("00000000-0000-0000-0000-0000000000ff");

beforeAll(() => { db = createDb(); });
afterAll(async () => { await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT)); });

test("reject sets status=rejected and stamps resolver", async () => {
  const { stagedProductId } = await stageProduct({
    db, tenantId: TENANT, merchantId: MERCHANT,
    adapterOutput: { observations: [], pricingObservations: [], inventoryObservations: [], identityHint: { targetIsVariant: false }, rawPayload: {} },
    sourceKind: "link", channelCode: null,
    verdict: { admit: false, missingFields: ["title"], blockingSignals: [], infoSignals: [] }, matchCandidates: []
  });
  await rejectStagedProduct({ db, tenantId: TENANT, stagedProductId, resolvedBy: "u1" });
  const [row] = await db.select().from(schema.stagedProducts).where(eq(schema.stagedProducts.stagedProductId, stagedProductId));
  expect(row?.status).toBe("rejected");
  expect(row?.resolvedBy).toBe("u1");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd packages/catalog/catalog-service test reject-staged`
Expected: FAIL — cannot find module `./reject-staged.js`.

- [ ] **Step 3: Write `reject-staged.ts`**

```typescript
// Anomaly Lab — staging gate. Reject a staged product. Terminal; kept for
// audit; never promoted. Spec §7.3.
import { eq, and } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";

export interface RejectStagedInput {
  db: DrizzleClient; tenantId: TenantId; stagedProductId: string; resolvedBy: string;
}

export async function rejectStagedProduct(input: RejectStagedInput): Promise<void> {
  const now = new Date();
  const res = await input.db.update(schema.stagedProducts)
    .set({ status: "rejected", resolvedBy: input.resolvedBy, resolvedAt: now, updatedAt: now })
    .where(and(
      eq(schema.stagedProducts.stagedProductId, input.stagedProductId),
      eq(schema.stagedProducts.tenantId, input.tenantId),
      eq(schema.stagedProducts.status, "pending")
    ))
    .returning({ id: schema.stagedProducts.stagedProductId });
  if (res.length === 0) throw new Error(`staged product ${input.stagedProductId} not pending`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun --cwd packages/catalog/catalog-service test reject-staged`
Expected: PASS.

- [ ] **Step 5: Write the link test**

`linkStagedProduct` confirms a `match_candidate` then promotes against it. Create `packages/catalog/catalog-service/src/staging/link-staged.test.ts`: seed a live product P; stage an item whose `match_candidates` includes `{productId: P, kind:"live"}`; call `linkStagedProduct({ stagedProductId, confirmedProductId: P, fills, resolvedBy })`; assert the staged item promotes onto P (no new product created) and observations attach to P.

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createDb, schema, type DrizzleClient } from "@aonex/db";
import { TenantId, MerchantId } from "@aonex/types";
import { eq } from "drizzle-orm";
import { stageProduct } from "./stage-product.js";
import { linkStagedProduct } from "./link-staged.js";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";

let db: DrizzleClient; let pid: string;
const TENANT = TenantId.unsafeFrom("00000000-0000-0000-0000-000000000a11");
const MERCHANT = MerchantId.unsafeFrom("00000000-0000-0000-0000-000000000a11");

const out: AdapterOutput = {
  observations: [{ attributeCode: "title", target: "parent", channelCode: "web", localeCode: "_unscoped", source: "link", sourceRecordId: "r", value: "Amazon copy", confidence: 1, observedAt: new Date() }],
  pricingObservations: [{ productHint: "p", channelCode: "amazon", locale: "_unscoped", source: "link", sourceRecordId: "r", currency: "USD", tiers: [{ kind: "list", amount: 12.5 }], observedAt: new Date() }],
  inventoryObservations: [], identityHint: { brand: "Acme", titleForFuzzy: "Amazon copy", targetIsVariant: false }, rawPayload: {}
};

beforeAll(async () => {
  db = createDb();
  const [row] = await db.insert(schema.catalogProducts).values({
    tenantId: TENANT, merchantId: MERCHANT, primaryIdentifier: "live-amz", identity: { brand: "Acme" },
    status: "active", values: {}, winningValues: {}
  } as never).returning({ id: schema.catalogProducts.productId });
  pid = row!.id;
});
afterAll(async () => {
  await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TENANT));
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT));
});

test("link confirms a candidate and promotes onto the live product", async () => {
  const { stagedProductId } = await stageProduct({
    db, tenantId: TENANT, merchantId: MERCHANT, adapterOutput: out,
    sourceKind: "link", channelCode: "amazon",
    verdict: { admit: false, missingFields: ["identifier"], blockingSignals: [{ signalKind: "identity_conflict", severity: "high", blocking: true }], infoSignals: [] },
    matchCandidates: [{ productId: pid, score: 0.6, kind: "live" }]
  });
  const r = await linkStagedProduct({ db, tenantId: TENANT, stagedProductId, confirmedProductId: pid, resolvedBy: "u1", fills: { gtin: "50000000001" } });
  expect(r.productId).toBe(pid);
});
```

- [ ] **Step 6: Run to verify failure**

Run: `bun --cwd packages/catalog/catalog-service test link-staged`
Expected: FAIL — cannot find module `./link-staged.js`.

- [ ] **Step 7: Write `link-staged.ts`**

```typescript
// Anomaly Lab — staging gate. Confirm a match candidate and promote the
// staged item onto that existing product (enrichment, per-channel).
// Spec §7.2 / reviewer action ③.
import { eq, and } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";
import { promoteStagedProduct, type PromoteStagedResult } from "./promote-staged.js";

export interface LinkStagedInput {
  db: DrizzleClient;
  tenantId: TenantId;
  stagedProductId: string;
  confirmedProductId: string;
  resolvedBy: string;
  fills: Record<string, unknown>;
}

export async function linkStagedProduct(input: LinkStagedInput): Promise<PromoteStagedResult> {
  // Validate the confirmed product is among the staged row's candidates.
  const [staged] = await input.db.select().from(schema.stagedProducts)
    .where(and(eq(schema.stagedProducts.stagedProductId, input.stagedProductId), eq(schema.stagedProducts.tenantId, input.tenantId)));
  if (!staged) throw new Error(`staged product ${input.stagedProductId} not found`);
  const candidates = (staged.matchCandidates as Array<{ productId: string }>) ?? [];
  if (!candidates.some((c) => c.productId === input.confirmedProductId)) {
    throw new Error(`product ${input.confirmedProductId} is not a candidate for staged ${input.stagedProductId}`);
  }
  // Promotion onto a live product skips the completeness gate for the NEW
  // product — the target already satisfied it. We force the productId so
  // the enrichment lands on it.
  return promoteStagedProduct({
    db: input.db, tenantId: input.tenantId, stagedProductId: input.stagedProductId,
    resolvedBy: input.resolvedBy, fills: input.fills, confirmedMatchProductId: input.confirmedProductId
  });
}
```

> `promoteStagedProduct` still runs `evaluateGate` on the filled output. When
> linking to a live product the gate may still flag `identifier` missing even
> though the target product is complete. For v1, `linkStagedProduct` passes
> `confirmedMatchProductId`; update `promoteStagedProduct` to **skip the gate
> re-check when `confirmedMatchProductId` is set** (the target already passed).
> Add that one guard: `if (!input.confirmedMatchProductId && !verdict.admit) throw …`.

- [ ] **Step 8: Apply the promote-staged guard for confirmed matches**

In `promote-staged.ts`, change the gate check to:

```typescript
    const verdict = evaluateGate({ adapterOutput: filled, signals: [] });
    if (!input.confirmedMatchProductId && !verdict.admit) {
      throw new StillIncompleteError(verdict.missingFields);
    }
```

- [ ] **Step 9: Run both tests + full package**

Run: `bun --cwd packages/catalog/catalog-service test`
Expected: PASS (reject + link + all prior).

- [ ] **Step 10: Export + commit**

In `packages/catalog/catalog-service/src/index.ts` add:

```typescript
export { promoteStagedProduct, StillIncompleteError } from "./staging/promote-staged.js";
export type { PromoteStagedInput, PromoteStagedResult } from "./staging/promote-staged.js";
export { rejectStagedProduct } from "./staging/reject-staged.js";
export type { RejectStagedInput } from "./staging/reject-staged.js";
export { linkStagedProduct } from "./staging/link-staged.js";
export type { LinkStagedInput } from "./staging/link-staged.js";
```

```bash
git add packages/catalog/catalog-service/src/staging/ packages/catalog/catalog-service/src/index.ts
git commit -m "feat(catalog): add rejectStagedProduct + linkStagedProduct staging ops"
```

---

## Task 10: Delete the `anomaly-lab` stub package

**Files:**
- Delete: `packages/anomaly-lab/`

- [ ] **Step 1: Confirm nothing imports it**

Run: `grep -rn "@aonex/anomaly-lab" --include="*.ts" apps packages | grep -v node_modules`
Expected: no results (the stub is unused).

- [ ] **Step 2: Delete the package**

Run: `git rm -r packages/anomaly-lab`

- [ ] **Step 3: Verify the workspace + build still resolve**

Run: `bun install && bun run typecheck`
Expected: install succeeds, typecheck passes (no dangling workspace reference).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove anomaly-lab stub package (folded into catalog-service)"
```

---

## Final verification

- [ ] **Run the catalog-service + worker + db test suites and typecheck the repo**

Run: `bun run typecheck && bun --cwd packages/catalog/catalog-service test && bun --cwd apps/worker test`
Expected: all green. Staging gate is live: incomplete/ambiguous ingests stage; complete ones reach the catalog; live matches enrich; staged items can be promoted/rejected/linked.

---

## Self-Review

**Spec coverage (against `2026-05-25-anomaly-lab-staging-gate-design.md`):**
- §4 chokepoint `admitOrStage` → Task 5. ✅
- §5.1 `canonical-minimum`, `evaluate-gate` → Task 2. ✅ (`gate/run-detectors`, `blocking-signals` deferred to detector-suite plan — `evaluateGate` already accepts `signals`.)
- §5.1 `staging/stage-product`, `promote-staged`, `reject-staged`, `link-staged` → Tasks 4, 8, 9. ✅
- §5.2 staging-aware `resolveIdentity` → Task 3. ✅
- §5.2 worker repoint → Task 6. ✅
- §5.3 delete `anomaly-lab` stub → Task 10. ✅
- §6 `staged_products` model → Task 1. ✅
- §7.1 promotion flow (pins + synthetic obs + write + gate re-check) → Task 8. ✅
- §7.2 multi-source enrichment / link → Tasks 5 (live match enrich) + 9 (link). ✅
- **Deferred (own plans, noted up top):** §5.1 `anomaly-lab.ts`/`lab-actions.ts` HTTP handlers + routes; `llm-suggest`; §8 detector classification (`BLOCKING_SIGNALS` + `run-detectors`); §9 frontend; `GET /lab/stats`. `forceProductId` (Task 7) added to support §7.2 linking — not in the spec's file list but required by it.

**Placeholder scan:** The two `where(... undefined ...)` cleanups in test snippets are intentionally flagged for the engineer to wire tenant-scoped deletes (note attached). No `TODO`/`TBD`/"implement later". All code steps show complete code.

**Type consistency:** `GateVerdict` (Task 2) is consumed by `stageProduct` (Task 4) and `promoteStagedProduct` (Task 8). `GateSignal` (Task 2) used by `admitOrStage` (Task 5). `resolveIdentity` `candidates: {productId,score,kind}` (Task 3) is read by `admitOrStage` (Task 5) and `stageProduct.matchCandidates` (Task 4) — same shape. `forceProductId` (Task 7) consumed by `promoteStagedProduct.confirmedMatchProductId` (Task 8) and `linkStagedProduct` (Task 9). `AdmitOrStageResult.outcome` (Task 5) read by worker repoint (Task 6). Consistent.

---

## Follow-on plans (not in this plan)

1. **Lab HTTP API** — `apps/api/src/routes/anomaly-lab.ts` + `handlers/anomaly-lab.ts` + `handlers/lab-actions.ts`: `GET /lab/queue`, `GET /lab/staged/:id`, `GET /lab/staged/:id/evidence`, `POST /lab/staged/:id/{approve,reject,link}`; wire into `composition-root.ts`; tenant-scoping (404) + optimistic-concurrency (409).
2. **LLM-assisted auto-fill** — `staging/llm-suggest.ts` + `POST /lab/staged/:id/suggest`, budget-capped, on-demand, never auto-applied.
3. **Detector suite + classification** — `gate/run-detectors.ts` (adapt the 9 `policy-engine` detectors to an `AdapterOutput`-derived `RouterInput`), `gate/blocking-signals.ts` (`price-anomaly` blocking; 6 informational), feed `evaluateGate`'s `signals`.
4. **Dashboard stats** — `GET /lab/stats` (counts by reason/source/age, throughput).
5. **Fresh frontend** — rebuild `(authenticated)/ingestion/anomaly-lab` (queue + dashboard + detail + evidence + actions) with the `frontend-design` skill.
