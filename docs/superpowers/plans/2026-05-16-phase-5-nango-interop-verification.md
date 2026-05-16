# Phase 5 — Nango Lane Canonical Interop Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** §2.1.1 + §17 Phase 5
**Depends on:** Phase 1 (canonical schema) + Phase 2 (spine + applyApprovedDiff rewrite)
**Blocks:** nothing

**Goal:** Verify the friend's Nango marketplace lane continues to produce approved `product_versions` after the Phase 1 + 2 changes ship — *without touching any Nango code*. The only crossing point is `applyApprovedDiff` (rewritten in Phase 1), which Nango-originated approved diffs flow through. Confirm `attributes_json` is populated, validator runs, audit chain is preserved.

**Architecture:** This is a pure verification phase. No new packages, no new processors. Add integration tests, a runbook for the Nango engineer, and an explicit smoke procedure to run against a connected Shopify test store. If verification fails, file specific issues — do NOT patch Nango code in this PR (separate coordination with the Nango engineer).

**Tech Stack:** Bun test (integration only), psql, existing Nango setup.

**Acceptance:** A live Nango Shopify drain produces ≥ 1 approved `product_version` with non-empty `attributes_json` and a populated `category_schema_version` (when category matches a Tier 1 seeded schema). No regressions in `sync-service.test.ts` or `link-catalog-pipeline.test.ts`.

---

## File Structure

**Files created**
- `apps/worker/src/services/nango-interop.test.ts` — integration test mocking the existing Nango drain → applyApprovedDiff path
- `docs/superpowers/runbooks/nango-canonical-interop.md`

**Files modified** — none

---

## Tasks

### Task 1: Branch + read the current Nango path

- [ ] **Step 1.1: Branch**

```bash
git checkout main && git pull --ff-only
git checkout -b feature/phase-5-nango-interop-verify
```

- [ ] **Step 1.2: Inventory the existing Nango path (read-only)**

```bash
ls apps/nango/
cat apps/worker/src/processors/nango-sync.processor.ts
cat apps/worker/src/processors/drain.processor.ts
cat apps/worker/src/processors/nango-auth.processor.ts
cat apps/api/src/routes/webhooks.ts | head -100
```

Document in your head where the Nango path:
1. Receives webhooks
2. Drains records into `source_artifacts`
3. Produces extracted_facts (if at all) → may stop at source_artifacts per current code
4. If/where it creates `proposed_diffs`
5. How those diffs reach `applyApprovedDiff`

If the Nango path does NOT currently produce proposed_diffs (i.e. it stops at source_artifacts), this verification will only test that `applyApprovedDiff` is callable from any future Nango code, not that data actually flows today. Note this in the runbook.

---

### Task 2: Write integration test simulating a Nango-originated diff

**Files:**
- Create: `apps/worker/src/services/nango-interop.test.ts`

- [ ] **Step 2.1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createDrizzleClient, type DrizzleClient } from "@aonex/db";    // adjust to actual export
import { schema } from "@aonex/db";
import { eq } from "drizzle-orm";
import { applyApprovedDiff } from "@aonex/catalog-service";
import { sha256Hex } from "@aonex/lib-utils";
import { randomUUID } from "node:crypto";

// Run against the live local Postgres. Skipped in CI unless DATABASE_URL points at a test DB.
const haveDb = !!process.env.DATABASE_URL;

let db: DrizzleClient;
let tenantId: string;
let merchantId: string;

beforeAll(async () => {
  if (!haveDb) return;
  db = createDrizzleClient({ connectionString: process.env.DATABASE_URL! });
  const [tenant] = await db.insert(schema.tenants).values({ name: `phase-5-tenant-${randomUUID()}` }).returning({ id: schema.tenants.id });
  tenantId = tenant.id;
  const [merchant] = await db.insert(schema.merchants).values({ tenantId, displayName: "Phase-5 Merchant" }).returning({ id: schema.merchants.id });
  merchantId = merchant.id;

  // Seed an active policy version
  await db.insert(schema.policyVersions).values({
    version: `phase-5-${randomUUID()}`,
    active: true,
    scoringWeights: {} as never
  }).onConflictDoNothing();

  // Seed a Tier 1 mobile_phones schema (the Phase 3 seeder would normally do this)
  await db.insert(schema.categorySchemas).values({
    categoryPath: "electronics/mobile_phones",
    schemaVersion: 1,
    jsonSchema: {
      $schema: "https://json-schema.org/draft/2019-09/schema",
      tier: "authoritative",
      required: ["ram_gb", "storage_gb", "screen_size_inches", "os", "battery_mah", "network_type"],
      properties: {
        ram_gb: { type: "integer" },
        storage_gb: { type: "integer" },
        screen_size_inches: { type: "number" },
        os: { type: "string" },
        battery_mah: { type: "integer" },
        network_type: { type: "string", enum: ["3G", "4G", "5G"] }
      },
      additionalProperties: true
    },
    requiredAttributes: ["ram_gb", "storage_gb", "screen_size_inches", "os", "battery_mah", "network_type"],
    optionalAttributes: [],
    variantOptions: {},
    marketplaceMappings: {},
    tier: "authoritative",
    displayName: "Mobile Phones",
    active: true
  }).onConflictDoNothing();
});

afterAll(async () => {
  if (!haveDb) return;
  // Best-effort cleanup; cascade FKs handle most rows.
  await db.delete(schema.merchants).where(eq(schema.merchants.tenantId, tenantId));
  await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
});

describe.if(haveDb)("Nango canonical interop", () => {
  it("applyApprovedDiff populates attributes_json for a Nango-originated diff payload", async () => {
    // Simulate what a Nango drain → field-extractor would produce after Phase 1 ships:
    // a proposed_diffs row with a diffPayload that has typed core + attributes object.
    const factSetId = await seedExtractedFactSet(db, tenantId, merchantId);

    const [diff] = await db.insert(schema.proposedDiffs).values({
      tenantId,
      merchantId,
      sourceFactSetId: factSetId,
      diffType: "create",
      status: "auto_approved",
      policyVersionId: (await db.query.policyVersions.findFirst({ where: (p, { eq }) => eq(p.active, true) }))!.id,
      confidenceScore: "0.95",
      actorType: "policy",
      diffPayload: {
        title: "Aonami Nova X",
        brand: "Aonami",
        gtin: "8901234567001",
        modelNumber: "NX-2026",
        manufacturerPartNumber: "NX-2026",
        description: "Mid-range Android phone",
        basePrice: 399.00,
        currency: "USD",
        weightGrams: 178,
        dimensionsCm: { l: 14.7, w: 7.1, h: 0.8 },
        canonicalCategory: "electronics/mobile_phones",
        categorySchemaVersion: "electronics/mobile_phones/v1",
        categoryConfidence: 0.99,
        images: [{ url: "https://example.com/nova-x.jpg" }],
        attributes: {
          ram_gb: 8,
          storage_gb: 128,
          screen_size_inches: 6.1,
          os: "Android 14",
          battery_mah: 4500,
          network_type: "5G"
        },
        variants: [],
        evidence: { sourceMarketplace: "shopify", externalId: "gid://shopify/Product/1001" }
      }
    }).returning({ id: schema.proposedDiffs.id });

    const result = await applyApprovedDiff({
      db,
      diffId: diff.id,
      approvalStatus: "auto_approved"
    });

    expect(result.productVersionId).toBeTruthy();

    const version = await db.query.productVersions.findFirst({
      where: (v, { eq }) => eq(v.id, result.productVersionId)
    });
    expect(version).toBeTruthy();
    expect(version!.attributesJson).toEqual({
      ram_gb: 8,
      storage_gb: 128,
      screen_size_inches: 6.1,
      os: "Android 14",
      battery_mah: 4500,
      network_type: "5G"
    });
    expect(version!.manufacturerPartNumber).toBe("NX-2026");
    expect(version!.weightGrams).toBe("178");
    expect(version!.categorySchemaVersion).toBe("electronics/mobile_phones/v1");
  });

  it("opens missing_required_attribute review task when Nango-extracted attributes are incomplete", async () => {
    const factSetId = await seedExtractedFactSet(db, tenantId, merchantId);

    const [diff] = await db.insert(schema.proposedDiffs).values({
      tenantId,
      merchantId,
      sourceFactSetId: factSetId,
      diffType: "create",
      status: "auto_approved",
      policyVersionId: (await db.query.policyVersions.findFirst({ where: (p, { eq }) => eq(p.active, true) }))!.id,
      confidenceScore: "0.87",
      actorType: "policy",
      diffPayload: {
        title: "Aonami Mini",
        brand: "Aonami",
        basePrice: 199.00,
        currency: "USD",
        canonicalCategory: "electronics/mobile_phones",
        attributes: {
          ram_gb: 4,
          storage_gb: 64
          // missing screen_size_inches, os, battery_mah, network_type
        },
        variants: [],
        evidence: {}
      }
    }).returning({ id: schema.proposedDiffs.id });

    await expect(applyApprovedDiff({
      db,
      diffId: diff.id,
      approvalStatus: "auto_approved"
    })).rejects.toThrow(/missing required/i);

    const tasks = await db.select().from(schema.reviewTasks).where(eq(schema.reviewTasks.proposedDiffId, diff.id));
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0].taskType).toBe("missing_required_attribute");
  });
});

async function seedExtractedFactSet(db: DrizzleClient, tenantId: string, merchantId: string): Promise<string> {
  const [art] = await db.insert(schema.sourceArtifacts).values({
    tenantId,
    merchantId,
    sourceType: "marketplace_connector",
    sourceMarketplace: "shopify",
    sourceExternalId: `gid://shopify/Product/${randomUUID()}`,
    rawData: {},
    checksum: sha256Hex(randomUUID()),
    status: "completed"
  }).returning({ id: schema.sourceArtifacts.id });

  const policy = await db.query.policyVersions.findFirst({ where: (p, { eq }) => eq(p.active, true) });

  const [run] = await db.insert(schema.extractionRuns).values({
    artifactId: art.id,
    tenantId,
    merchantId,
    extractorVersion: "test-nango",
    mapperVersion: "test-1",
    policyVersionId: policy!.id,
    status: "succeeded",
    startedAt: new Date(),
    completedAt: new Date()
  }).returning({ id: schema.extractionRuns.id });

  const [fs] = await db.insert(schema.extractedFactSets).values({
    extractionRunId: run.id,
    artifactId: art.id,
    tenantId,
    merchantId
  }).returning({ id: schema.extractedFactSets.id });

  return fs.id;
}
```

- [ ] **Step 2.2: Run the integration test**

```bash
DATABASE_URL=$DATABASE_URL bun --cwd apps/worker test src/services/nango-interop.test.ts
```

Expected: both tests pass against the local Postgres. If they fail, examine the error — most likely a column-name mismatch or missing schema seed.

- [ ] **Step 2.3: Commit**

```bash
git add apps/worker/src/services/nango-interop.test.ts
git commit -m "test(worker): Nango canonical interop tests (Phase 1+2 effects on Nango lane)"
```

---

### Task 3: Manual smoke against a real Nango Shopify drain (if connection exists)

**Files:** none (operational)

- [ ] **Step 3.1: Confirm a Nango Shopify connection exists**

```bash
psql "$DATABASE_URL" -c "SELECT id, marketplace, provider_connection_id, status FROM marketplace_connections WHERE marketplace = 'shopify' LIMIT 5;"
```

If none exist, skip Steps 3.2–3.4 and document the gap in the runbook (Task 4) — the Nango engineer can perform this verification when they have a live test store.

- [ ] **Step 3.2: Trigger a sync**

If the Nango engineer's path exposes a "trigger sync" route, hit it. Otherwise wait for a webhook to arrive naturally.

- [ ] **Step 3.3: Inspect the result**

```bash
psql "$DATABASE_URL" -c "
SELECT pv.title, pv.canonical_category, pv.attributes_json, pv.category_schema_version, pv.confidence_score
FROM product_versions pv
JOIN proposed_diffs pd ON pd.id = pv.proposed_diff_id
JOIN extracted_fact_sets fs ON fs.id = pd.source_fact_set_id
JOIN source_artifacts sa ON sa.id = fs.artifact_id
WHERE sa.source_type = 'marketplace_connector'
ORDER BY pv.created_at DESC
LIMIT 5;
"
```

Expected: rows show non-empty `attributes_json`. If `attributes_json` is `{}` or NULL for Nango-sourced versions, the Nango path is NOT producing the `attributes` key in its diffPayload — this is a Nango-side bug that the Nango engineer must fix. Document in the runbook.

- [ ] **Step 3.4: Confirm no regressions in existing Nango tests**

```bash
bun --cwd apps/worker test 2>&1 | grep -E "sync-service|drain"
```

Expected: all pass.

---

### Task 4: Write the canonical-interop runbook

**Files:**
- Create: `docs/superpowers/runbooks/nango-canonical-interop.md`

- [ ] **Step 4.1: Runbook**

```markdown
# Runbook — Nango lane canonical interop

## What this covers

After Phase 1 (canonical schema fix) + Phase 2 (ingestion spine for link/CSV
lanes), the Nango marketplace lane must continue to produce approved
product_versions with the new schema columns populated. Nango code itself is
NOT touched in this work — only the canonical layer it lands in (specifically
applyApprovedDiff).

## What works automatically

Any Nango-originated proposed_diff that gets approved flows through the new
applyApprovedDiff, which:
- Populates attributes_json from diffPayload.attributes
- Populates weight_grams, dimensions_cm, manufacturer_part_number from typed payload fields
- Runs JSON Schema validation against category_schemas
- Pins category_schema_version on the product_version
- Opens review tasks for missing required attributes (Tier 1 categories only)

## What the Nango engineer needs to update on their side

If the Nango field extractor (currently `packages/ingestion/field-extractor/strategies/shopify.ts`
and friends) does NOT produce a diffPayload.attributes key, then Nango-sourced
products will land with empty attributes_json. To fix, the Nango engineer must:

1. Have their extractor emit a payload shaped like:
   ```
   {
     title, brand, gtin, modelNumber, manufacturerPartNumber,
     basePrice, currency, weightGrams, dimensionsCm,
     canonicalCategory,
     attributes: { <category-specific attrs from Shopify metafields, productType, etc.> },
     variants: [...]
   }
   ```

2. Map Shopify metafields whose namespace = "specs" (or merchant-configured)
   into the attributes object using the canonical attribute keys (e.g.
   `screen_size_inches`, `resolution`).

3. The CanonicalProductPayload TypeScript interface in
   `packages/catalog/catalog-service/src/index.ts` is the source of truth for
   the shape.

## Verifying interop

Run the integration tests at:
```bash
bun --cwd apps/worker test src/services/nango-interop.test.ts
```

Run the live smoke check:
```sql
SELECT pv.title, pv.attributes_json, pv.category_schema_version
FROM product_versions pv
JOIN proposed_diffs pd ON pd.id = pv.proposed_diff_id
JOIN extracted_fact_sets fs ON fs.id = pd.source_fact_set_id
JOIN source_artifacts sa ON sa.id = fs.artifact_id
WHERE sa.source_type = 'marketplace_connector'
ORDER BY pv.created_at DESC
LIMIT 10;
```

If `attributes_json` is `{}` on Nango-sourced rows, the Nango extractor
side needs the upgrade above.

## When the Nango path stops producing diffs

Currently (as of Phase 5 verification), the Nango drain may only persist
source_artifacts and NOT continue through to proposed_diffs. If this is the
case, the integration tests in `nango-interop.test.ts` still pass because
they simulate the diff directly — but live Nango syncs will NOT produce
product_versions until the Nango engineer wires the extract step.

This is documented in the spec §2.1.1 as out-of-scope for this design phase.
```

- [ ] **Step 4.2: Commit**

```bash
git add docs/superpowers/runbooks/nango-canonical-interop.md
git commit -m "docs: Nango canonical interop runbook"
```

---

### Task 5: PR

- [ ] **Step 5.1: Push + PR**

```bash
git push -u origin feature/phase-5-nango-interop-verify
gh pr create \
  --title "test(phase-5): Nango lane canonical interop verification" \
  --body "$(cat <<'BODY'
## Summary
- Integration tests confirming that applyApprovedDiff (Phase 1) correctly handles a Nango-originated proposed_diff payload
- Runbook documenting what the Nango engineer must update on their side for full interop
- NO Nango code changes (spec §2.1.1 explicitly preserves the Nango lane)

## Acceptance
- [ ] Integration tests pass against local Postgres
- [ ] Existing sync-service.test.ts and link-catalog-pipeline.test.ts still pass
- [ ] Runbook accurate and reviewed by Nango engineer

## Spec
docs/superpowers/specs/2026-05-16-unified-ingestion-design.md §2.1.1 + §17 Phase 5

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Self-Review

1. **Spec coverage** — Phase 5 acceptance: verification only, no Nango code touched, canonical interop confirmed. Tasks 2 = integration tests; Task 3 = live smoke; Task 4 = runbook. ✓
2. **Placeholder scan** — None. ✓
3. **Type consistency** — `CanonicalProductPayload` shape referenced consistently in the runbook. ✓

---

## Phase boundary

Phase 5 is a verification gate, not a code-change phase. Phase 6 begins the extraction-pack expansion (Layers A–H polish + new parsers + Playwright + ScrapingBee).
