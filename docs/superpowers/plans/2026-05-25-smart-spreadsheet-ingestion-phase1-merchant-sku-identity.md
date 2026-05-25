# Smart Spreadsheet Ingestion — Phase 1: Merchant-SKU Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a merchant's own SKU a valid hard identifier so jewelry/CSV products (no GTIN/MPN) pass the Anomaly Lab gate, enrich on re-upload, and never fuzzy-merge into each other.

**Architecture:** Additive, backward-compatible change to three already-built catalog-service pieces — the `IdentityHint` type, the staging gate (`evaluate-gate.ts`), the identity resolver (`identity-resolver.ts`), and the catalog write key (`catalog-write.ts`). Link/connector adapters never set the new field, so their behavior is unchanged. This is Phase 1 of the spec `2026-05-25-smart-spreadsheet-ingestion-design.md` §14 — it gates every later CSV phase.

**Tech Stack:** TypeScript, Drizzle ORM, `bun test` (`bun:test`), Postgres test DB (`@aonex/db/testing` → `connectTestDb`).

**Branch:** Cut `feat/smart-spreadsheet-ingestion` from `feat/anomaly-lab-staging-gate` (where the staging core lives). All commits land there.

**Prereqs:** A Postgres test DB reachable by `connectTestDb()` (same one the existing `admit-or-stage.test.ts` / `identity-resolver.staging.test.ts` use). Run all commands from `aonex-backend/`.

---

### Task 1: `primary_identifier` on `IdentityHint` + gate acceptance

A merchant SKU on the identity hint must satisfy the gate's `identifier` requirement (today only `gtin`/`mpn` do).

**Files:**
- Modify: `packages/catalog/source-adapters/src/types.ts:67-78` (add field to `IdentityHint`)
- Modify: `packages/catalog/catalog-service/src/canonical-minimum.ts:10` (update comment)
- Modify: `packages/catalog/catalog-service/src/gate/evaluate-gate.ts:43-52` (`hasIdentifier`)
- Test: `packages/catalog/catalog-service/src/gate/evaluate-gate.test.ts` (append two tests)

- [ ] **Step 1: Write the failing tests**

Append to `packages/catalog/catalog-service/src/gate/evaluate-gate.test.ts`:

```typescript
test("primary_identifier (merchant SKU) satisfies 'identifier' with no gtin/mpn", () => {
  const v = evaluateGate(input({
    adapterOutput: output({
      identityHint: {
        brand: "MyJeweler",
        primary_identifier: "m1:RG19",
        titleForFuzzy: "14K Gold Diamond Ring",
        targetIsVariant: false
      }
    })
  }));
  expect(v.missingFields).not.toContain("identifier");
  expect(v.admit).toBe(true);
});

test("no gtin/mpn AND no primary_identifier → still missing 'identifier'", () => {
  const v = evaluateGate(input({
    adapterOutput: output({
      identityHint: { brand: "MyJeweler", titleForFuzzy: "Ring", targetIsVariant: false }
    })
  }));
  expect(v.missingFields).toEqual(["identifier"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/catalog/catalog-service && bun test src/gate/evaluate-gate.test.ts`
Expected: FAIL — the first test fails (TypeScript: `primary_identifier` not on `IdentityHint`, and/or `admit` is `false` because identifier is reported missing).

- [ ] **Step 3: Add `primary_identifier` to `IdentityHint`**

In `packages/catalog/source-adapters/src/types.ts`, inside `interface IdentityHint`, add after the `mpn?` line:

```typescript
  /** Merchant-supplied SKU (e.g. CSV Tag No.). A hard identifier within the
   *  tenant/merchant scope — used by the gate and resolver when no gtin/mpn
   *  exists. Set only by the CSV adapter; link/connector adapters leave it unset. */
  primary_identifier?: string;
```

- [ ] **Step 4: Accept it in the gate**

In `packages/catalog/catalog-service/src/gate/evaluate-gate.ts`, replace the body of `hasIdentifier`:

```typescript
function hasIdentifier(out: AdapterOutput): boolean {
  // A HARD identifier present at gate time. For scraped/marketplace sources
  // that's gtin/mpn. For a merchant uploading their own catalog (CSV), their
  // own SKU (primary_identifier) is the hard ID — it identifies the product
  // within the tenant. brand is deliberately NOT an identifier.
  const h = out.identityHint;
  return isNonEmptyString(h.gtin) || isNonEmptyString(h.mpn) || isNonEmptyString(h.primary_identifier);
}
```

- [ ] **Step 5: Update the `CANONICAL_MINIMUM` comment to match**

In `packages/catalog/catalog-service/src/canonical-minimum.ts`, change the `identifier` line comment:

```typescript
  "identifier"      // a hard ID present at gate time: gtin OR mpn OR a merchant-supplied primary_identifier (brand is NOT an identifier)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/catalog/catalog-service && bun test src/gate/evaluate-gate.test.ts`
Expected: PASS — all tests in the file (the two new ones plus the existing 8).

- [ ] **Step 7: Commit**

```bash
git add packages/catalog/source-adapters/src/types.ts \
        packages/catalog/catalog-service/src/canonical-minimum.ts \
        packages/catalog/catalog-service/src/gate/evaluate-gate.ts \
        packages/catalog/catalog-service/src/gate/evaluate-gate.test.ts
git commit -m "feat(catalog): accept merchant primary_identifier as a hard ID at the gate"
```

---

### Task 2: Resolver exact `primary_identifier` match path (before fuzzy)

When the hint carries a `primary_identifier`, resolve by exact match on `catalog_products.primaryIdentifier`. Critically: if present but no exact match, return `none` and **do not fall through to fuzzy** — otherwise distinct pieces sharing the merchant brand + near-identical synthetic titles would merge.

**Files:**
- Modify: `packages/catalog/catalog-service/src/identity-resolver.ts` (IdentityHint type:33-39; `IdentityMatchPath`:64-69; new path before the fuzzy block:153)
- Test: `packages/catalog/catalog-service/src/identity-resolver.primary-id.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/catalog/catalog-service/src/identity-resolver.primary-id.test.ts`:

```typescript
// Integration test — resolveIdentity primary_identifier (merchant SKU) path.
// Unique tenant to avoid colliding with other resolver test files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import { connectTestDb, closeTestDb, ensureTestMerchant, TEST_MERCHANT_ID } from "@aonex/db/testing";
import type { TenantId } from "@aonex/types";
import { resolveIdentity } from "./identity-resolver.js";

const TENANT_ID = "a0000000-0000-0000-0000-0000000000aa";
const TENANT = TENANT_ID as unknown as TenantId;

describe("resolveIdentity — primary_identifier (merchant SKU)", () => {
  let db: DrizzleClient;
  let rg19Id: string;

  beforeAll(async () => {
    db = await connectTestDb();
    await db.insert(schema.tenants)
      .values({ id: TENANT_ID, name: "Primary-ID Test Tenant", status: "active" })
      .onConflictDoNothing();
    await ensureTestMerchant(db);
    await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TENANT_ID));

    // Two distinct pieces, SAME brand, near-identical titles — the fuzzy-merge trap.
    const rg19 = await db.insert(schema.catalogProducts).values({
      tenantId: TENANT_ID, merchantId: TEST_MERCHANT_ID,
      primaryIdentifier: "m1:RG19",
      identity: { brand: "MyJeweler", primary_identifier: "m1:RG19" },
      status: "active", values: {}
    }).returning({ productId: schema.catalogProducts.productId });
    rg19Id = rg19[0]!.productId;

    await db.insert(schema.catalogProducts).values({
      tenantId: TENANT_ID, merchantId: TEST_MERCHANT_ID,
      primaryIdentifier: "m1:RG21",
      identity: { brand: "MyJeweler", primary_identifier: "m1:RG21" },
      status: "active", values: {}
    });
  });

  afterAll(async () => {
    await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TENANT_ID));
    await closeTestDb();
  });

  test("exact match → matchPath 'primary_id', correct product, live candidate", async () => {
    const r = await resolveIdentity({ db, tenantId: TENANT, identityHint: { primary_identifier: "m1:RG19" } });
    expect(r.matchPath).toBe("primary_id");
    expect(r.productId).toBe(rg19Id);
    expect(r.strength).toBe(1.0);
    expect(r.candidates[0]).toMatchObject({ productId: rg19Id, kind: "live", score: 1.0 });
  });

  test("present but no exact match → 'none', and does NOT fuzzy-merge a same-brand sibling", async () => {
    const r = await resolveIdentity({
      db, tenantId: TENANT,
      // Same brand + a title that WOULD fuzzy-match RG19 — but primary_identifier is set.
      identityHint: { primary_identifier: "m1:RG99", brand: "MyJeweler", titleForFuzzy: "14K Gold Diamond Ring" }
    });
    expect(r.matchPath).toBe("none");
    expect(r.productId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/catalog/catalog-service && bun test src/identity-resolver.primary-id.test.ts`
Expected: FAIL — TypeScript error (`primary_identifier` not on the resolver's `IdentityHint`; `"primary_id"` not in `IdentityMatchPath`).

- [ ] **Step 3: Add the field and match-path type**

In `packages/catalog/catalog-service/src/identity-resolver.ts`, add to the local `IdentityHint` interface (after `mpn?`):

```typescript
  /** Merchant-supplied SKU. When present, resolution is exact-or-none (fuzzy
   *  is skipped — a merchant-keyed product is either its own prior key or new). */
  primary_identifier?: string;
```

Then extend the `IdentityMatchPath` union to include `"primary_id"`:

```typescript
export type IdentityMatchPath =
  | "gtin"
  | "mpn_brand"
  | "primary_id"
  | "fuzzy_high"
  | "fuzzy_review"
  | "none";
```

- [ ] **Step 4: Insert the exact match path before the fuzzy block**

In `packages/catalog/catalog-service/src/identity-resolver.ts`, immediately before the `// ---- 3. Fuzzy identity` comment (around line 153), insert:

```typescript
  // ---- 2.5 Merchant SKU: primary_identifier exact match -----------------
  // A merchant-supplied SKU is a hard identifier within the tenant. When the
  // hint carries one, resolve EXACT-OR-NONE: an exact hit enriches; no hit
  // means a genuinely new product. We deliberately skip the fuzzy path here —
  // CSV SKUs share one brand (the merchant) and carry near-identical synthetic
  // titles, so fuzzy scoring would merge distinct pieces.
  if (identityHint.primary_identifier) {
    const rows = await db
      .select({ productId: schema.catalogProducts.productId })
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.tenantId, tenantId),
          eq(schema.catalogProducts.primaryIdentifier, identityHint.primary_identifier)
        )
      )
      .limit(1);
    const hit = rows[0];
    if (hit) {
      return {
        productId: hit.productId,
        strength: 1.0,
        reviewTaskSuggested: false,
        matchPath: "primary_id",
        candidateProductIds: [hit.productId],
        candidates: [{ productId: hit.productId, score: 1.0, kind: "live" }]
      };
    }
    // No exact match: new product. Skip fuzzy (see comment above).
    return {
      productId: null,
      strength: 0,
      reviewTaskSuggested: false,
      matchPath: "none",
      candidateProductIds: [],
      candidates: []
    };
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/catalog/catalog-service && bun test src/identity-resolver.primary-id.test.ts`
Expected: PASS — both tests.

- [ ] **Step 6: Run the existing resolver test for regression**

Run: `cd packages/catalog/catalog-service && bun test src/identity-resolver.staging.test.ts`
Expected: PASS — the gtin/mpn/fuzzy/staged paths are untouched (no hint carries `primary_identifier`).

- [ ] **Step 7: Commit**

```bash
git add packages/catalog/catalog-service/src/identity-resolver.ts \
        packages/catalog/catalog-service/src/identity-resolver.primary-id.test.ts
git commit -m "feat(catalog): resolver primary_identifier exact-or-none path (skips fuzzy)"
```

---

### Task 3: `writeAdapterOutput` keys on `primary_identifier` + end-to-end acceptance

Make a new product's `primaryIdentifier` use the merchant SKU (so re-uploads resolve to it via Task 2), persist it in `identity`, and prove the whole §14 behavior through `admitOrStage`: a jewelry-like product (no gtin/mpn) **admits**, re-upload **enriches**, and two distinct same-brand SKUs stay **separate**.

**Files:**
- Modify: `packages/catalog/catalog-service/src/catalog-write.ts:369-381` (key precedence + identity persist)
- Test: `packages/catalog/catalog-service/src/admit-or-stage.primary-id.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/catalog/catalog-service/src/admit-or-stage.primary-id.test.ts`. It mirrors the harness in `admit-or-stage.test.ts` (tenant/merchant/channel/rules seeding + cleanup), then exercises the merchant-SKU path:

```typescript
// Integration — admitOrStage with merchant primary_identifier (no gtin/mpn).
// Proves §14: jewelry-like SKU admits, re-upload enriches, distinct SKUs don't merge.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import { closeTestDb, connectTestDb } from "@aonex/db/testing";
import type { ChannelId, MerchantId, TenantId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import { admitOrStage } from "./admit-or-stage.js";

const TENANT_ID = "c0000000-0000-0000-0000-0000000000a1";
const MERCHANT_ID = "c0000000-0000-0000-0000-0000000000a2";
const CHANNEL_ID = "c0000000-0000-0000-0000-0000000000a3";
const CHANNEL_CODE = "csv-in";
const TENANT = TENANT_ID as unknown as TenantId;
const MERCHANT = MERCHANT_ID as unknown as MerchantId;
const CHANNEL = CHANNEL_ID as unknown as ChannelId;
const TEST_ACTOR = "test:aos-primary-id";

// A complete jewelry-like SKU: no gtin/mpn, brand = merchant name, primary_identifier = namespaced Tag No.
function jewelryOutput(primaryId: string, title: string, suffix: string): AdapterOutput {
  return {
    observations: [
      { attributeCode: "title", target: "parent", channelCode: CHANNEL_CODE, localeCode: "en_IN",
        source: "spreadsheet:stock.xlsx", sourceRecordId: `csv:${suffix}`, value: title, confidence: 0.9,
        observedAt: new Date("2026-05-25T10:00:00Z") },
      { attributeCode: "category_path", target: "parent", channelCode: CHANNEL_CODE, localeCode: "en_IN",
        source: "spreadsheet:stock.xlsx", sourceRecordId: `csv:${suffix}-cat`, value: "Jewelry > Rings",
        confidence: 0.9, observedAt: new Date("2026-05-25T10:00:00Z") }
    ],
    pricingObservations: [
      { productHint: primaryId, channelCode: CHANNEL_CODE, locale: "en_IN", source: "spreadsheet:stock.xlsx",
        sourceRecordId: `csv:${suffix}-price`, currency: "INR", tiers: [{ kind: "list", amount: 57515.92 }],
        observedAt: new Date("2026-05-25T10:00:00Z") }
    ],
    inventoryObservations: [],
    identityHint: { brand: "MyJeweler", primary_identifier: primaryId, titleForFuzzy: title, targetIsVariant: false },
    rawPayload: { src: "aos-primary-id-test" }
  };
}

async function cleanup(db: DrizzleClient): Promise<void> {
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT_ID));
  await db.delete(schema.catalogPricingObservations).where(eq(schema.catalogPricingObservations.tenantId, TENANT_ID));
  await db.execute(sql`DELETE FROM catalog_events WHERE tenant_id = ${TENANT_ID}`);
  await db.execute(sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`);
  await db.delete(schema.catalogProductRevisions).where(eq(schema.catalogProductRevisions.tenantId, TENANT_ID));
  await db.execute(sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`);
  await db.delete(schema.identityLog).where(eq(schema.identityLog.tenantId, TENANT_ID));
  await db.delete(schema.reviewTasks).where(eq(schema.reviewTasks.tenantId, TENANT_ID));
  await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TENANT_ID));
  await db.delete(schema.channels).where(eq(schema.channels.channelId, CHANNEL_ID));
  await db.delete(schema.sourcePriority).where(eq(schema.sourcePriority.actor, TEST_ACTOR));
  await db.delete(schema.merchants).where(eq(schema.merchants.id, MERCHANT_ID));
  await db.delete(schema.tenants).where(eq(schema.tenants.id, TENANT_ID));
}

async function seed(db: DrizzleClient): Promise<void> {
  await db.insert(schema.tenants).values({ id: TENANT_ID, name: "AOS PrimaryID Tenant", status: "active" }).onConflictDoNothing();
  await db.insert(schema.merchants).values({
    id: MERCHANT_ID, tenantId: TENANT_ID, email: "aos-primary-id@tests.internal",
    passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only", displayName: "AOS PrimaryID Merchant",
    defaultCurrency: "INR"
  }).onConflictDoNothing();
  await db.insert(schema.channels).values({
    channelId: CHANNEL_ID, tenantId: TENANT_ID, channelKind: "csv", region: "in",
    accountRef: "aos-primary-id-tests", defaultCurrency: "INR", defaultLocale: "en_IN", displayName: "CSV In"
  }).onConflictDoNothing();
  await db.insert(schema.sourcePriority).values({
    tenantId: null, attributeCode: null, sourceGlob: "*", channelScope: null, priority: 100,
    rulesVersion: 1, actor: TEST_ACTOR
  });
}

describe("admitOrStage — merchant primary_identifier", () => {
  let db: DrizzleClient;
  beforeAll(async () => { db = await connectTestDb(); await cleanup(db); await seed(db); });
  afterAll(async () => { await cleanup(db); await closeTestDb(); });

  test("jewelry SKU (no gtin/mpn) → admitted, keyed on primary_identifier", async () => {
    const r = await admitOrStage({
      db, tenantId: TENANT, merchantId: MERCHANT,
      adapterOutput: jewelryOutput("m1:RG19", "14K Gold Diamond Ring RG19", "RG19"),
      sourceKind: "spreadsheet", actor: TEST_ACTOR, channelCode: CHANNEL_CODE,
      channelCodeToId: { [CHANNEL_CODE]: CHANNEL }
    });
    expect(r.outcome).toBe("admitted");
    expect(r.productId).not.toBeNull();
    const rows = await db.select().from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.primaryIdentifier, "m1:RG19"));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.identity as Record<string, unknown>)["primary_identifier"]).toBe("m1:RG19");
  });

  test("re-upload of the same SKU → enriched (same product, no duplicate)", async () => {
    const r = await admitOrStage({
      db, tenantId: TENANT, merchantId: MERCHANT,
      adapterOutput: jewelryOutput("m1:RG19", "14K Gold Diamond Ring RG19", "RG19-again"),
      sourceKind: "spreadsheet", actor: TEST_ACTOR, channelCode: CHANNEL_CODE,
      channelCodeToId: { [CHANNEL_CODE]: CHANNEL }
    });
    expect(r.outcome).toBe("enriched");
    const rows = await db.select().from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.primaryIdentifier, "m1:RG19"));
    expect(rows).toHaveLength(1); // still one — enriched, not duplicated
  });

  test("distinct same-brand SKU → admitted as a SEPARATE product (no fuzzy merge)", async () => {
    const r = await admitOrStage({
      db, tenantId: TENANT, merchantId: MERCHANT,
      adapterOutput: jewelryOutput("m1:RG21", "14K Gold Diamond Ring RG21", "RG21"),
      sourceKind: "spreadsheet", actor: TEST_ACTOR, channelCode: CHANNEL_CODE,
      channelCodeToId: { [CHANNEL_CODE]: CHANNEL }
    });
    expect(r.outcome).toBe("admitted");
    const rg21 = await db.select().from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.primaryIdentifier, "m1:RG21"));
    const rg19 = await db.select().from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.primaryIdentifier, "m1:RG19"));
    expect(rg21).toHaveLength(1);
    expect(rg19).toHaveLength(1);
    expect(rg21[0]!.productId).not.toBe(rg19[0]!.productId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/catalog/catalog-service && bun test src/admit-or-stage.primary-id.test.ts`
Expected: FAIL — test 1's `primaryIdentifier === "m1:RG19"` assertion fails (today the key is `gtin ?? mpn ?? stableNonUuidIdentifier(...)` → a random `catalog:...:uuid`), and test 2's `enriched` assertion fails (re-upload can't match the random key → it admits a duplicate).

- [ ] **Step 3: Make the key precedence prefer `primary_identifier`**

In `packages/catalog/catalog-service/src/catalog-write.ts`, change the `primaryIdentifier` assignment (currently lines 369-372):

```typescript
      const primaryIdentifier =
        adapterOutput.identityHint.gtin ??
        adapterOutput.identityHint.mpn ??
        adapterOutput.identityHint.primary_identifier ??
        stableNonUuidIdentifier(adapterOutput.identityHint);
```

- [ ] **Step 4: Persist `primary_identifier` into the identity JSON**

In the same block, after the existing `if (adapterOutput.identityHint.brand) identityJson["brand"] = ...;` line, add:

```typescript
      if (adapterOutput.identityHint.primary_identifier)
        identityJson["primary_identifier"] = adapterOutput.identityHint.primary_identifier;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/catalog/catalog-service && bun test src/admit-or-stage.primary-id.test.ts`
Expected: PASS — admitted + keyed on `m1:RG19`; re-upload enriched (one row); distinct `m1:RG21` separate.

- [ ] **Step 6: Run the existing admit-or-stage + catalog-write tests for regression**

Run: `cd packages/catalog/catalog-service && bun test src/admit-or-stage.test.ts src/catalog-write.test.ts`
Expected: PASS — gtin/mpn keying and the link/connector routing matrix are unchanged (those outputs never set `primary_identifier`, so `gtin ?? mpn ?? ...` still wins).

- [ ] **Step 7: Commit**

```bash
git add packages/catalog/catalog-service/src/catalog-write.ts \
        packages/catalog/catalog-service/src/admit-or-stage.primary-id.test.ts
git commit -m "feat(catalog): writeAdapterOutput keys on merchant primary_identifier; e2e admit/enrich/no-merge"
```

---

### Task 4: Full-package verification

- [ ] **Step 1: Run the whole catalog-service + source-adapters suites**

Run: `cd packages/catalog/catalog-service && bun test` then `cd ../source-adapters && bun test`
Expected: PASS — no regressions anywhere.

- [ ] **Step 2: Typecheck both packages**

Run: `cd packages/catalog/catalog-service && bun run typecheck` then `cd ../source-adapters && bun run typecheck`
Expected: no type errors.

- [ ] **Step 3: Commit any incidental fixes (if Steps 1-2 surfaced one)**

```bash
git add -A && git commit -m "chore(catalog): phase-1 verification fixes"
```

---

## Self-Review

**Spec coverage (§14):** ✅ `IdentityHint += primary_identifier` (Task 1, Step 3). ✅ `hasIdentifier` accepts it (Task 1, Step 4). ✅ `canonical-minimum` comment (Task 1, Step 5). ✅ resolver exact-`primaryIdentifier` path before fuzzy (Task 2). ✅ exact-or-none / skip-fuzzy correctness (Task 2, Step 4 + test). ✅ `catalog-write` key precedence + identity persist (Task 3, Steps 3-4). ✅ merchant-namespaced `primary_identifier` value (`"m1:RG19"` form) exercised in tests — the *production* namespacing (`"<merchantId>:<TagNo>"`) is set by the CSV adapter in a later phase, noted in the spec §8.3 / Phase 4. ✅ backward-compat (regression steps: Task 2 Step 6, Task 3 Step 6). ✅ no-fuzzy-merge proof (Task 3, test 3).

**Placeholder scan:** none — every code step shows complete code; every run step shows the command + expected result.

**Type consistency:** `primary_identifier` (snake_case) used consistently on both `IdentityHint` definitions (source-adapters + resolver) and in `identityJson`. `matchPath: "primary_id"` added to the `IdentityMatchPath` union (Task 2 Step 3) and returned in Task 2 Step 4 + asserted in its test. `admitOrStage` input/result fields match the real signature read from `admit-or-stage.ts`.

**Known v1 limitation (out of Phase 1 scope):** re-uploading an *incomplete* CSV SKU that was previously **staged** will create a second staged row (the resolver's staged search matches by gtin only, not `primary_identifier`). Acceptable for Phase 1; staged-accumulation-by-`primary_identifier` is a later refinement. Complete-SKU enrichment (the common case) is fully covered.
