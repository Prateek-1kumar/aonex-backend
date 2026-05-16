# Phase 1 — Canonical Schema Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-16-unified-ingestion-design.md` (commit `217cedb`)

**Goal:** Repair the canonical `product_versions` schema to carry the full HLD §8.1 4-layer model (typed core + jsonb attributes + variants + identities), wire JSON-Schema validation into `applyApprovedDiff`, and backfill existing data without breaking the running link extractor.

**Architecture:** Edit Drizzle TS schemas → `drizzle-kit generate` produces the SQL → apply via `drizzle-kit migrate`. New `@aonex/schema-validator` workspace package wraps Ajv 8 (JSON Schema 2019-09) with Aonex custom keywords (`tier`, `confidence_required`). `applyApprovedDiff` is rewritten to populate `attributes_json` + 6 other new columns and to call the validator pre-insert. Chunked backfill job moves existing `merchant_extensions_json.attributes` → `attributes_json` for already-approved versions.

**Tech Stack:** TypeScript, Drizzle ORM 0.36, drizzle-kit 0.30, PostgreSQL 16, Ajv 8 (`ajv` + `ajv-formats`), Bun runtime, Bun's built-in test runner, BullMQ (chunked backfill).

**Acceptance for the phase:** All migrations apply cleanly to a fresh staging DB. `applyApprovedDiff` populates `attributes_json` + 6 new columns. Validator opens `missing_required_attribute` review tasks for Tier 1 misses. Existing golden fixtures still process. Backfill dry-run completes without error; live backfill migrates all approved versions on staging. No regressions in `apps/worker/src/services/sync-service.test.ts` or `link-catalog-pipeline.test.ts`.

---

## File Structure

**Files created**
- `packages/db/src/schema/category-labels.ts` — new schema definition
- `packages/db/src/schema/tenant-category-overlays.ts` — new schema definition
- `packages/db/src/schema/category-attribute-promotion-candidates.ts` — new schema definition
- `packages/db/drizzle/0005_canonical_schema_repair.sql` — generated migration (filename auto-numbered)
- `packages/schema-validator/package.json`
- `packages/schema-validator/tsconfig.json`
- `packages/schema-validator/src/index.ts`
- `packages/schema-validator/src/validator.ts`
- `packages/schema-validator/src/aonex-keywords.ts`
- `packages/schema-validator/src/types.ts`
- `packages/schema-validator/src/validator.test.ts`
- `packages/schema-validator/src/fixtures/tents.schema.json`
- `packages/schema-validator/src/fixtures/mobile-phones.schema.json`
- `packages/schema-validator/src/fixtures/umbrellas.schema.json`
- `packages/catalog/catalog-service/src/apply-approved-diff.test.ts`
- `apps/worker/src/jobs/backfill-attributes-json.ts`
- `apps/worker/src/jobs/backfill-attributes-json.test.ts`

**Files modified**
- `packages/db/src/schema/products.ts` — add 7 column definitions to `product_versions`
- `packages/db/src/schema/category.ts` — add `tier`, `parent_path`, `display_name`, `active` columns
- `packages/db/src/schema/index.ts` — re-export the 3 new schema files
- `packages/db/src/sql/triggers.sql` — verify immutability trigger covers new columns (read-only verification + amend if needed)
- `packages/catalog/catalog-service/src/index.ts` — rewrite `applyApprovedDiff` (~lines 100–155) to populate new columns and call validator
- `packages/catalog/catalog-service/package.json` — add `@aonex/schema-validator` dep
- `apps/worker/src/jobs/index.ts` — register `backfill-attributes-json` cron
- `apps/worker/package.json` — add `@aonex/schema-validator` dep (transitively via catalog-service)
- `package.json` — add `packages/schema-validator` to workspaces if not auto-detected
- `.env.example` — no changes for Phase 1; validator is library-only

---

## Tasks

### Task 1: Branch + baseline check

**Files:** none

- [ ] **Step 1.1: Create feature branch from main**

```bash
git checkout main && git pull --ff-only && git checkout -b feature/phase-1-canonical-schema
```

- [ ] **Step 1.2: Run baseline tests to confirm CI-green starting state**

```bash
bun test 2>&1 | tail -20
```

Expected: all existing tests pass. If anything is red, stop and fix upstream before touching schema.

- [ ] **Step 1.3: Snapshot the current `product_versions` columns**

```bash
psql "$DATABASE_URL" -c "\d product_versions" > /tmp/pv-before.txt
```

Keep `/tmp/pv-before.txt` for later comparison.

---

### Task 2: Add 7 new columns to `product_versions` (Drizzle TS)

**Files:**
- Modify: `packages/db/src/schema/products.ts` (lines 86–119 — the `productVersions` definition)

- [ ] **Step 2.1: Edit `productVersions` to add 7 nullable columns**

Replace the column block (after `proposedDiffId`) with:

```typescript
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id").notNull(),
    merchantId: uuid("merchant_id").notNull(),
    proposedDiffId: uuid("proposed_diff_id")
      .notNull()
      .references(() => proposedDiffs.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 500 }).notNull(),
    brand: varchar("brand", { length: 200 }),
    gtin: varchar("gtin", { length: 30 }),
    gtinType: varchar("gtin_type", { length: 10 }),
    modelNumber: varchar("model_number", { length: 100 }),
    manufacturerPartNumber: varchar("manufacturer_part_number", { length: 100 }),
    basePrice: numeric("base_price", { precision: 12, scale: 4 }),
    currency: varchar("currency", { length: 3 }),
    weightGrams: numeric("weight_grams", { precision: 12, scale: 3 }),
    dimensionsCm: jsonb("dimensions_cm").$type<{ l?: number; w?: number; h?: number }>(),
    images: jsonb("images").$type<Array<{ url: string; altText?: string }>>(),
    description: text("description"),
    canonicalCategory: varchar("canonical_category", { length: 300 }),
    categorySchemaVersion: varchar("category_schema_version", { length: 50 }),
    categoryConfidence: numeric("category_confidence", { precision: 5, scale: 4 }),
    attributesJson: jsonb("attributes_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 4 }).notNull(),
    schemaVersion: varchar("schema_version", { length: 20 }).notNull().default("1"),
    merchantExtensionsJson: jsonb("merchant_extensions_json").$type<Record<string, unknown>>(),
    evidenceSummary: jsonb("evidence_summary").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
```

The seven new columns: `gtinType`, `manufacturerPartNumber`, `weightGrams`, `dimensionsCm`, `categorySchemaVersion`, `categoryConfidence`, `attributesJson`, `evidenceSummary` (eight in total — the spec counts `gtinType` as part of `gtin`-pair).

- [ ] **Step 2.2: Add the `attributesJson` GIN index in the table-builder callback**

Locate the existing `(t) => ({ ... })` block and add:

```typescript
  (t) => ({
    productIdx: index("idx_product_versions_product").on(t.productId),
    diffIdx: index("idx_product_versions_diff").on(t.proposedDiffId),
    createdIdx: index("idx_product_versions_created").on(t.tenantId, t.createdAt),
    attrsGinIdx: index("idx_product_versions_attrs_gin")
      .using("gin", t.attributesJson),
    categoryIdx: index("idx_product_versions_category").on(t.canonicalCategory)
  })
```

- [ ] **Step 2.3: Run typecheck on the db package**

```bash
bun --bun --cwd packages/db typecheck
```

Expected: no errors. If `import { index }` is missing, add it to the drizzle-orm/pg-core imports at the top of the file.

- [ ] **Step 2.4: Commit the schema change**

```bash
git add packages/db/src/schema/products.ts
git commit -m "feat(db): add Layer 1/3 columns + GIN index to product_versions"
```

---

### Task 3: Add `tier`, `parent_path`, `display_name`, `active` to `category_schemas`

**Files:**
- Modify: `packages/db/src/schema/category.ts`

- [ ] **Step 3.1: Edit `categorySchemas` to add 4 new columns**

Insert these column definitions before `createdAt`:

```typescript
    tier: varchar("tier", { length: 20 }).notNull().default("authoritative"),
    parentPath: varchar("parent_path", { length: 300 }),
    displayName: varchar("display_name", { length: 200 }).notNull().default(""),
    active: boolean("active").notNull().default(true),
```

Add `boolean` to the imports from `drizzle-orm/pg-core` at the top of the file.

- [ ] **Step 3.2: Typecheck**

```bash
bun --bun --cwd packages/db typecheck
```

Expected: no errors.

- [ ] **Step 3.3: Commit**

```bash
git add packages/db/src/schema/category.ts
git commit -m "feat(db): add tier/parent_path/display_name/active to category_schemas"
```

---

### Task 4: Create `category_labels` schema (localized display names)

**Files:**
- Create: `packages/db/src/schema/category-labels.ts`

- [ ] **Step 4.1: Write the schema file**

```typescript
// HLD §4.5 / spec §4.5 — localized display names per category_path.
// Codes are immutable; labels translate.

import {
  pgTable,
  varchar,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";

export const categoryLabels = pgTable(
  "category_labels",
  {
    categoryPath: varchar("category_path", { length: 300 }).notNull(),
    locale: varchar("locale", { length: 10 }).notNull(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: uniqueIndex("uq_category_labels").on(t.categoryPath, t.locale)
  })
);

export type CategoryLabel = typeof categoryLabels.$inferSelect;
export type NewCategoryLabel = typeof categoryLabels.$inferInsert;
```

- [ ] **Step 4.2: Re-export from schema index**

Open `packages/db/src/schema/index.ts` and add:

```typescript
export * from "./category-labels.js";
```

- [ ] **Step 4.3: Typecheck + commit**

```bash
bun --bun --cwd packages/db typecheck && \
  git add packages/db/src/schema/category-labels.ts packages/db/src/schema/index.ts && \
  git commit -m "feat(db): add category_labels table for localized display names"
```

---

### Task 5: Create `tenant_category_overlays` schema (multi-tenant variance)

**Files:**
- Create: `packages/db/src/schema/tenant-category-overlays.ts`

- [ ] **Step 5.1: Write the schema file**

```typescript
// Spec §11.2 — additive JSON Schema overlay composed via allOf at validator time.
// Tenants may strengthen required and narrow enums; cannot weaken core requirements.

import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

export const tenantCategoryOverlays = pgTable(
  "tenant_category_overlays",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    categoryPath: varchar("category_path", { length: 300 }).notNull(),
    schemaVersion: varchar("schema_version", { length: 50 }).notNull(),
    overlayJson: jsonb("overlay_json").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: uniqueIndex("uq_tenant_category_overlays").on(
      t.tenantId,
      t.categoryPath,
      t.schemaVersion
    )
  })
);

export type TenantCategoryOverlay = typeof tenantCategoryOverlays.$inferSelect;
export type NewTenantCategoryOverlay = typeof tenantCategoryOverlays.$inferInsert;
```

- [ ] **Step 5.2: Re-export from schema index**

Append to `packages/db/src/schema/index.ts`:

```typescript
export * from "./tenant-category-overlays.js";
```

- [ ] **Step 5.3: Typecheck + commit**

```bash
bun --bun --cwd packages/db typecheck && \
  git add packages/db/src/schema/tenant-category-overlays.ts packages/db/src/schema/index.ts && \
  git commit -m "feat(db): add tenant_category_overlays for multi-tenant schema variance"
```

---

### Task 6: Create `category_attribute_promotion_candidates` schema (for Phase 3)

**Files:**
- Create: `packages/db/src/schema/category-attribute-promotion-candidates.ts`

- [ ] **Step 6.1: Write the schema file**

```typescript
// Spec §10 — populated by the schema-promotion-scan cron in Phase 3.
// Ship the table now so we don't need another migration in Phase 3.

import {
  pgTable,
  uuid,
  varchar,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  index
} from "drizzle-orm/pg-core";

export const categoryAttributePromotionCandidates = pgTable(
  "category_attribute_promotion_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryPath: varchar("category_path", { length: 300 }).notNull(),
    attributeKey: varchar("attribute_key", { length: 200 }).notNull(),
    productsWithKey: integer("products_with_key").notNull().default(0),
    totalProducts: integer("total_products").notNull().default(0),
    consistencyRatio: numeric("consistency_ratio", { precision: 5, scale: 4 }).notNull().default("0"),
    /** "candidate" | "proposed" | "approved" | "rejected" */
    status: varchar("status", { length: 20 }).notNull().default("candidate"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    uniqueCandidate: uniqueIndex("uq_promotion_candidates").on(t.categoryPath, t.attributeKey),
    statusIdx: index("idx_promotion_candidates_status").on(t.status)
  })
);

export type PromotionCandidate = typeof categoryAttributePromotionCandidates.$inferSelect;
export type NewPromotionCandidate = typeof categoryAttributePromotionCandidates.$inferInsert;
```

- [ ] **Step 6.2: Re-export + typecheck + commit**

```bash
echo 'export * from "./category-attribute-promotion-candidates.js";' >> packages/db/src/schema/index.ts
bun --bun --cwd packages/db typecheck
git add packages/db/src/schema/category-attribute-promotion-candidates.ts packages/db/src/schema/index.ts
git commit -m "feat(db): add category_attribute_promotion_candidates (used by Phase 3)"
```

---

### Task 7: Generate the migration via drizzle-kit

**Files:** drizzle-kit will create `packages/db/drizzle/0005_<name>.sql` and a `meta/_journal.json` snapshot.

- [ ] **Step 7.1: Run drizzle-kit generate**

```bash
bun --bun --cwd packages/db drizzle-kit generate
```

Expected output: prints "Generated 1 migration" and creates a new SQL file. drizzle-kit names it automatically — note the filename for later steps.

- [ ] **Step 7.2: Inspect the generated SQL**

```bash
ls -lt packages/db/drizzle/*.sql | head -3
cat $(ls -t packages/db/drizzle/0*.sql | head -1)
```

Verify the generated SQL contains:
- `ALTER TABLE "product_versions" ADD COLUMN "gtin_type" varchar(10);`
- `ALTER TABLE "product_versions" ADD COLUMN "manufacturer_part_number" varchar(100);`
- `ALTER TABLE "product_versions" ADD COLUMN "weight_grams" numeric(12, 3);`
- `ALTER TABLE "product_versions" ADD COLUMN "dimensions_cm" jsonb;`
- `ALTER TABLE "product_versions" ADD COLUMN "category_schema_version" varchar(50);`
- `ALTER TABLE "product_versions" ADD COLUMN "category_confidence" numeric(5, 4);`
- `ALTER TABLE "product_versions" ADD COLUMN "attributes_json" jsonb DEFAULT '{}'::jsonb NOT NULL;`
- `ALTER TABLE "product_versions" ADD COLUMN "evidence_summary" jsonb;`
- `ALTER TABLE "category_schemas" ADD COLUMN "tier" varchar(20) DEFAULT 'authoritative' NOT NULL;`
- `ALTER TABLE "category_schemas" ADD COLUMN "parent_path" varchar(300);`
- `ALTER TABLE "category_schemas" ADD COLUMN "display_name" varchar(200) DEFAULT '' NOT NULL;`
- `ALTER TABLE "category_schemas" ADD COLUMN "active" boolean DEFAULT true NOT NULL;`
- `CREATE TABLE "category_labels" (...)`
- `CREATE TABLE "tenant_category_overlays" (...)`
- `CREATE TABLE "category_attribute_promotion_candidates" (...)`
- `CREATE INDEX "idx_product_versions_attrs_gin" ON "product_versions" USING gin ("attributes_json");`

If anything is missing, return to the corresponding TS schema file and fix it, then re-run generate (delete the just-created migration first).

- [ ] **Step 7.3: Apply migration to local dev DB**

```bash
bun --bun --cwd packages/db drizzle-kit migrate
```

Expected: "Applied 1 migration".

- [ ] **Step 7.4: Verify columns are present**

```bash
psql "$DATABASE_URL" -c "\d product_versions" | grep -E "attributes_json|weight_grams|category_schema_version"
```

Expected: 3 lines confirming columns exist.

- [ ] **Step 7.5: Commit migration files**

```bash
git add packages/db/drizzle/
git commit -m "feat(db): generate migration for canonical schema repair (Phase 1)"
```

---

### Task 8: Verify immutability trigger covers new columns

**Files:**
- Read-only inspection: `packages/db/src/sql/triggers.sql`
- Modify only if trigger uses a fixed column list

- [ ] **Step 8.1: Inspect the existing trigger**

```bash
cat packages/db/src/sql/triggers.sql 2>/dev/null || \
  psql "$DATABASE_URL" -c "\df+ pg_get_functiondef" \
  -c "SELECT pg_get_functiondef('public.fn_product_versions_immutable'::regproc);"
```

Determine whether the trigger raises an error on ANY column change to `product_versions` (good — automatically covers new columns) or whitelists specific columns (bad — must be updated).

- [ ] **Step 8.2: If trigger uses fixed column list, amend it**

Add a new migration file `packages/db/drizzle/9999_extend_immutability_trigger.sql` (drizzle-kit doesn't generate raw SQL DDL; we hand-write trigger updates as a separate file). Example if needed:

```sql
-- Phase 1: ensure immutability trigger blocks updates to the new columns
CREATE OR REPLACE FUNCTION fn_product_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'product_versions is immutable (HLD §8.3); create a new version via proposed_diff approval';
END;
$$;
```

If the trigger is generic (raises on any UPDATE/DELETE), skip the migration. Just verify with:

```bash
psql "$DATABASE_URL" -c "UPDATE product_versions SET title = 'x' WHERE id = (SELECT id FROM product_versions LIMIT 1);"
```

Expected: raises an exception. If it succeeds, the trigger is broken — investigate before continuing.

- [ ] **Step 8.3: Commit if changes were made**

```bash
git add packages/db/src/sql/triggers.sql packages/db/drizzle/
git diff --cached --quiet || git commit -m "fix(db): ensure immutability trigger covers new product_versions columns"
```

---

### Task 9: Bootstrap `@aonex/schema-validator` package

**Files:**
- Create: `packages/schema-validator/package.json`
- Create: `packages/schema-validator/tsconfig.json`
- Create: `packages/schema-validator/src/index.ts`

- [ ] **Step 9.1: Create the directory and `package.json`**

```bash
mkdir -p packages/schema-validator/src
```

`packages/schema-validator/package.json`:

```json
{
  "name": "@aonex/schema-validator",
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
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1"
  }
}
```

- [ ] **Step 9.2: Create `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 9.3: Create the empty entry point**

`packages/schema-validator/src/index.ts`:

```typescript
export { validate, type ValidationOutcome } from "./validator.js";
export type { CategorySchemaInput, AttributesInput } from "./types.js";
```

- [ ] **Step 9.4: Install dependencies**

```bash
bun install
```

Expected: bun installs `ajv` and `ajv-formats` into the workspace.

- [ ] **Step 9.5: Commit the package skeleton**

```bash
git add packages/schema-validator/ package.json bun.lock
git commit -m "feat(schema-validator): scaffold workspace package"
```

---

### Task 10: Write the failing validator test (TDD step 1)

**Files:**
- Create: `packages/schema-validator/src/fixtures/tents.schema.json`
- Create: `packages/schema-validator/src/fixtures/mobile-phones.schema.json`
- Create: `packages/schema-validator/src/fixtures/umbrellas.schema.json`
- Create: `packages/schema-validator/src/validator.test.ts`

- [ ] **Step 10.1: Create the tent fixture schema**

`packages/schema-validator/src/fixtures/tents.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2019-09/schema",
  "$id": "category_schemas/outdoor_camping_tents/v1",
  "type": "object",
  "tier": "authoritative",
  "required": [
    "capacity_persons",
    "season_rating",
    "packed_weight_grams",
    "peak_height_cm",
    "waterproof_rating_mm"
  ],
  "properties": {
    "capacity_persons": { "type": "integer", "minimum": 1, "maximum": 12 },
    "season_rating": { "type": "string", "enum": ["3-season", "4-season"] },
    "packed_weight_grams": { "type": "number", "minimum": 0 },
    "peak_height_cm": { "type": "number", "minimum": 0 },
    "waterproof_rating_mm": { "type": "number", "minimum": 0 },
    "color": { "type": "string" },
    "pole_material": { "type": "string" },
    "footprint_cm": { "type": "array", "items": { "type": "number" } }
  },
  "additionalProperties": true
}
```

- [ ] **Step 10.2: Create the mobile-phones fixture schema**

`packages/schema-validator/src/fixtures/mobile-phones.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2019-09/schema",
  "$id": "category_schemas/electronics_mobile_phones/v1",
  "type": "object",
  "tier": "authoritative",
  "required": [
    "ram_gb",
    "storage_gb",
    "screen_size_inches",
    "os",
    "battery_mah",
    "network_type"
  ],
  "properties": {
    "ram_gb": { "type": "integer", "minimum": 1 },
    "storage_gb": { "type": "integer", "minimum": 1 },
    "screen_size_inches": { "type": "number", "minimum": 1, "maximum": 20 },
    "os": { "type": "string" },
    "battery_mah": { "type": "integer", "minimum": 0 },
    "network_type": { "type": "string", "enum": ["3G", "4G", "5G"] },
    "camera_megapixels": { "type": "integer", "minimum": 0 },
    "ip_rating": { "type": "string" },
    "ports": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": true
}
```

- [ ] **Step 10.3: Create the umbrellas Tier-2 fixture schema**

`packages/schema-validator/src/fixtures/umbrellas.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2019-09/schema",
  "$id": "category_schemas/luggage_bags_umbrellas/v0_inferred",
  "type": "object",
  "tier": "inferred",
  "required": [],
  "properties": {},
  "additionalProperties": true
}
```

- [ ] **Step 10.4: Write the failing validator test**

`packages/schema-validator/src/validator.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./index.js";

const fixtureDir = join(import.meta.dir, "fixtures");
const tentsSchema = JSON.parse(readFileSync(join(fixtureDir, "tents.schema.json"), "utf-8"));
const mobilesSchema = JSON.parse(readFileSync(join(fixtureDir, "mobile-phones.schema.json"), "utf-8"));
const umbrellasSchema = JSON.parse(readFileSync(join(fixtureDir, "umbrellas.schema.json"), "utf-8"));

describe("validate — Tier 1 strict (tents)", () => {
  it("accepts a tent with all required attributes", () => {
    const result = validate(tentsSchema, {
      capacity_persons: 2,
      season_rating: "3-season",
      packed_weight_grams: 2400,
      peak_height_cm: 110,
      waterproof_rating_mm: 2000,
      color: "Green"
    });
    expect(result.valid).toBe(true);
    expect(result.missingRequired).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("flags missing required season_rating", () => {
    const result = validate(tentsSchema, {
      capacity_persons: 2,
      packed_weight_grams: 2400,
      peak_height_cm: 110,
      waterproof_rating_mm: 2000
    });
    expect(result.valid).toBe(false);
    expect(result.missingRequired).toContain("season_rating");
  });

  it("rejects out-of-range integer", () => {
    const result = validate(tentsSchema, {
      capacity_persons: 99,
      season_rating: "3-season",
      packed_weight_grams: 2400,
      peak_height_cm: 110,
      waterproof_rating_mm: 2000
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "/capacity_persons")).toBe(true);
  });

  it("rejects enum value outside allowed list", () => {
    const result = validate(tentsSchema, {
      capacity_persons: 2,
      season_rating: "2-season",
      packed_weight_grams: 2400,
      peak_height_cm: 110,
      waterproof_rating_mm: 2000
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "/season_rating")).toBe(true);
  });
});

describe("validate — Tier 1 strict (mobile_phones)", () => {
  it("accepts a complete iPhone", () => {
    const result = validate(mobilesSchema, {
      ram_gb: 8,
      storage_gb: 256,
      screen_size_inches: 6.1,
      os: "iOS 17",
      battery_mah: 3274,
      network_type: "5G"
    });
    expect(result.valid).toBe(true);
  });

  it("flags missing required battery_mah and network_type", () => {
    const result = validate(mobilesSchema, {
      ram_gb: 8,
      storage_gb: 256,
      screen_size_inches: 6.1,
      os: "iOS 17"
    });
    expect(result.valid).toBe(false);
    expect(result.missingRequired).toEqual(
      expect.arrayContaining(["battery_mah", "network_type"])
    );
  });
});

describe("validate — Tier 2 permissive (umbrellas)", () => {
  it("accepts arbitrary attributes when schema has empty required[]", () => {
    const result = validate(umbrellasSchema, {
      color: "Black",
      opening_mechanism: "automatic",
      frame_material: "fiberglass",
      canopy_diameter_cm: 105
    });
    expect(result.valid).toBe(true);
    expect(result.missingRequired).toEqual([]);
  });

  it("accepts an empty attributes object on Tier 2", () => {
    const result = validate(umbrellasSchema, {});
    expect(result.valid).toBe(true);
  });
});
```

- [ ] **Step 10.5: Run the test to verify it fails (validator not yet implemented)**

```bash
bun --cwd packages/schema-validator test 2>&1 | tail -20
```

Expected: tests fail with "Cannot find module './validator.js'" or similar. **This is the TDD red phase — do not implement the validator yet.**

- [ ] **Step 10.6: Commit failing tests**

```bash
git add packages/schema-validator/src/validator.test.ts packages/schema-validator/src/fixtures/
git commit -m "test(schema-validator): failing tests for tent/mobile/umbrella categories"
```

---

### Task 11: Implement the validator (TDD step 2 — minimal to pass)

**Files:**
- Create: `packages/schema-validator/src/validator.ts`
- Create: `packages/schema-validator/src/types.ts`
- Create: `packages/schema-validator/src/aonex-keywords.ts`

- [ ] **Step 11.1: Create the type definitions**

`packages/schema-validator/src/types.ts`:

```typescript
/** A JSON Schema 2019-09 document with Aonex custom keywords. */
export interface CategorySchemaInput {
  $schema?: string;
  $id?: string;
  type?: "object";
  /** "authoritative" | "inferred" | "promoted_draft" — see spec §4.4 */
  tier?: "authoritative" | "inferred" | "promoted_draft";
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
  /** Aonex custom keyword: per-attribute confidence threshold for auto-approval */
  confidence_required?: Record<string, number>;
  [k: string]: unknown;
}

export type AttributesInput = Record<string, unknown>;

export interface ValidationOutcome {
  valid: boolean;
  /** Names of required keys that were absent (subset of schema.required) */
  missingRequired: string[];
  /** Type / enum / range errors */
  errors: Array<{
    path: string;          // e.g. "/capacity_persons"
    message: string;       // e.g. "must be integer"
    keyword: string;       // e.g. "type", "enum", "maximum"
  }>;
  /** Echoes the tier from the schema for the caller's routing logic */
  tier: "authoritative" | "inferred" | "promoted_draft";
}
```

- [ ] **Step 11.2: Create the Aonex custom keywords module**

`packages/schema-validator/src/aonex-keywords.ts`:

```typescript
// Aonex custom JSON Schema keywords. Both are no-ops at validation time
// (they carry metadata for downstream callers like the policy engine),
// but Ajv requires them to be declared so unknown-keyword errors don't fire.

import type Ajv from "ajv";

export function registerAonexKeywords(ajv: Ajv): void {
  ajv.addKeyword({
    keyword: "tier",
    type: "object",
    schemaType: "string",
    // No validate function — pure metadata; presence is allowed but does not affect outcome.
    validate: () => true
  });

  ajv.addKeyword({
    keyword: "confidence_required",
    type: "object",
    schemaType: "object",
    // Per-attribute confidence thresholds; consumed by the policy engine, not the validator.
    validate: () => true
  });
}
```

- [ ] **Step 11.3: Implement the validator**

`packages/schema-validator/src/validator.ts`:

```typescript
import Ajv2019, { type ErrorObject } from "ajv/dist/2019.js";
import addFormats from "ajv-formats";
import { registerAonexKeywords } from "./aonex-keywords.js";
import type {
  CategorySchemaInput,
  AttributesInput,
  ValidationOutcome
} from "./types.js";

const ajv = new Ajv2019({
  strict: false,            // Allow Aonex custom keywords without errors
  allErrors: true,          // Collect every error, not just first
  removeAdditional: false,  // Tier 1 schemas use additionalProperties: true; never strip
  useDefaults: false,       // Don't mutate input
  coerceTypes: false        // Strict type checks — caller must pre-coerce units
});

addFormats(ajv);
registerAonexKeywords(ajv);

/**
 * Validate an attributes_json object against a category JSON Schema 2019-09.
 *
 * @param schema  The category_schemas.json_schema value.
 * @param attrs   The attributes_json to validate.
 */
export function validate(
  schema: CategorySchemaInput,
  attrs: AttributesInput
): ValidationOutcome {
  const validateFn = ajv.compile(schema);
  const valid = validateFn(attrs) as boolean;
  const errors = validateFn.errors ?? [];

  const missingRequired: string[] = [];
  const otherErrors: ValidationOutcome["errors"] = [];

  for (const err of errors as ErrorObject[]) {
    if (err.keyword === "required") {
      const missing = (err.params as { missingProperty?: string }).missingProperty;
      if (missing) missingRequired.push(missing);
    } else {
      otherErrors.push({
        path: err.instancePath || "/",
        message: err.message ?? "validation error",
        keyword: err.keyword
      });
    }
  }

  return {
    valid: missingRequired.length === 0 && otherErrors.length === 0,
    missingRequired,
    errors: otherErrors,
    tier: schema.tier ?? "authoritative"
  };
}
```

- [ ] **Step 11.4: Run tests to confirm they pass**

```bash
bun --cwd packages/schema-validator test 2>&1 | tail -25
```

Expected: all tests pass (7 passing across 3 describe blocks). If any fail, fix the validator before continuing.

- [ ] **Step 11.5: Commit**

```bash
git add packages/schema-validator/src/validator.ts packages/schema-validator/src/types.ts packages/schema-validator/src/aonex-keywords.ts
git commit -m "feat(schema-validator): Ajv 2019-09 validator with Aonex custom keywords"
```

---

### Task 12: Write failing test for `applyApprovedDiff` populating new columns

**Files:**
- Create: `packages/catalog/catalog-service/src/apply-approved-diff.test.ts`
- Modify: `packages/catalog/catalog-service/package.json` (add validator dep)

- [ ] **Step 12.1: Add `@aonex/schema-validator` dependency**

Open `packages/catalog/catalog-service/package.json` and add to `dependencies`:

```json
    "@aonex/schema-validator": "workspace:*"
```

Then:

```bash
bun install
```

- [ ] **Step 12.2: Write the failing test**

`packages/catalog/catalog-service/src/apply-approved-diff.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { applyApprovedDiff, type CanonicalProductPayload } from "./index.js";

// Mock the drizzle client — captures inserted product_versions rows so we can assert on them.
function makeMockDb(opts: {
  diff: {
    id: string;
    tenantId: string;
    merchantId: string;
    productId: string | null;
    diffPayload: Record<string, unknown>;
    confidenceScore: string;
  };
  categorySchema: Record<string, unknown> | null;
}) {
  const insertedVersions: Array<Record<string, unknown>> = [];
  const insertedProducts: Array<Record<string, unknown>> = [];
  const insertedReviewTasks: Array<Record<string, unknown>> = [];
  const queries: Record<string, unknown> = {
    proposedDiffs: {
      findFirst: async () => opts.diff
    },
    productVersions: { findFirst: async () => null },
    categorySchemas: {
      findFirst: async () => opts.categorySchema
    }
  };

  return {
    query: queries,
    insert: (table: { tableName?: string }) => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => {
          const arr =
            table.tableName === "products"
              ? insertedProducts
              : table.tableName === "review_tasks"
                ? insertedReviewTasks
                : insertedVersions;
          arr.push(v);
          return Promise.resolve([{ id: `mock-${arr.length}` }]);
        }
      })
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    _insertedVersions: insertedVersions,
    _insertedProducts: insertedProducts,
    _insertedReviewTasks: insertedReviewTasks
  };
}

const tentSchema = {
  $schema: "https://json-schema.org/draft/2019-09/schema",
  tier: "authoritative",
  required: [
    "capacity_persons",
    "season_rating",
    "packed_weight_grams",
    "peak_height_cm",
    "waterproof_rating_mm"
  ],
  properties: {
    capacity_persons: { type: "integer" },
    season_rating: { type: "string", enum: ["3-season", "4-season"] },
    packed_weight_grams: { type: "number" },
    peak_height_cm: { type: "number" },
    waterproof_rating_mm: { type: "number" }
  },
  additionalProperties: true
};

const completeTentPayload: CanonicalProductPayload = {
  title: "MH100 2-Person Tent",
  brand: "Quechua",
  gtin: "3608451234567",
  modelNumber: null,
  manufacturerPartNumber: "8492348",
  description: null,
  basePrice: 49.99,
  currency: "EUR",
  weightGrams: 2400,
  dimensionsCm: { l: 58, w: 16, h: 16 },
  canonicalCategory: "outdoor/camping/tents",
  categorySchemaVersion: "2026-05-08.tents.v1",
  categoryConfidence: 0.94,
  images: [],
  attributes: {
    capacity_persons: 2,
    season_rating: "3-season",
    packed_weight_grams: 2400,
    peak_height_cm: 110,
    waterproof_rating_mm: 2000,
    color: "Green"
  },
  variants: [],
  evidence: { sourceUrl: "https://decathlon.com/mh100" }
};

describe("applyApprovedDiff — Phase 1 canonical schema", () => {
  it("populates attributes_json and 6 new columns on Tier 1 success", async () => {
    const db = makeMockDb({
      diff: {
        id: "diff-1",
        tenantId: "tenant-1",
        merchantId: "merchant-1",
        productId: null,
        diffPayload: completeTentPayload as unknown as Record<string, unknown>,
        confidenceScore: "0.87"
      },
      categorySchema: tentSchema
    });

    const result = await applyApprovedDiff({
      db: db as never,
      diffId: "diff-1",
      approvalStatus: "auto_approved"
    });

    expect(result.productVersionId).toBeTruthy();
    expect(db._insertedVersions).toHaveLength(1);

    const row = db._insertedVersions[0];
    expect(row.attributesJson).toEqual({
      capacity_persons: 2,
      season_rating: "3-season",
      packed_weight_grams: 2400,
      peak_height_cm: 110,
      waterproof_rating_mm: 2000,
      color: "Green"
    });
    expect(row.weightGrams).toBe("2400");                     // numeric coerced to string by drizzle
    expect(row.dimensionsCm).toEqual({ l: 58, w: 16, h: 16 });
    expect(row.manufacturerPartNumber).toBe("8492348");
    expect(row.categorySchemaVersion).toBe("2026-05-08.tents.v1");
    expect(row.categoryConfidence).toBe("0.94");
    expect(row.evidenceSummary).toEqual({ sourceUrl: "https://decathlon.com/mh100" });
  });

  it("opens missing_required_attribute review task when Tier 1 required field is absent", async () => {
    const incompletePayload: CanonicalProductPayload = {
      ...completeTentPayload,
      attributes: {
        capacity_persons: 2,
        packed_weight_grams: 2400,
        peak_height_cm: 110,
        waterproof_rating_mm: 2000
        // missing season_rating
      }
    };
    const db = makeMockDb({
      diff: {
        id: "diff-2",
        tenantId: "tenant-1",
        merchantId: "merchant-1",
        productId: null,
        diffPayload: incompletePayload as unknown as Record<string, unknown>,
        confidenceScore: "0.87"
      },
      categorySchema: tentSchema
    });

    await expect(
      applyApprovedDiff({
        db: db as never,
        diffId: "diff-2",
        approvalStatus: "auto_approved"
      })
    ).rejects.toThrow(/missing required/i);

    // No product_version created
    expect(db._insertedVersions).toHaveLength(0);
    // Review task emitted
    expect(db._insertedReviewTasks).toHaveLength(1);
    const task = db._insertedReviewTasks[0];
    expect(task.taskType).toBe("missing_required_attribute");
    expect((task.contextJson as Record<string, unknown>).missingRequired).toEqual(["season_rating"]);
  });

  it("does NOT validate when category_schema is Tier 2 (inferred)", async () => {
    const umbrellaPayload: CanonicalProductPayload = {
      title: "Auto-Open Umbrella",
      brand: "StormGuard",
      gtin: null,
      modelNumber: null,
      manufacturerPartNumber: null,
      description: null,
      basePrice: 24.99,
      currency: "USD",
      weightGrams: 380,
      dimensionsCm: null,
      canonicalCategory: "luggage_bags/umbrellas",
      categorySchemaVersion: null,
      categoryConfidence: 0.82,
      images: [],
      attributes: {
        color: "Black",
        opening_mechanism: "automatic"
      },
      variants: [],
      evidence: {}
    };

    const db = makeMockDb({
      diff: {
        id: "diff-3",
        tenantId: "tenant-1",
        merchantId: "merchant-1",
        productId: null,
        diffPayload: umbrellaPayload as unknown as Record<string, unknown>,
        confidenceScore: "0.81"
      },
      categorySchema: {
        $schema: "https://json-schema.org/draft/2019-09/schema",
        tier: "inferred",
        required: [],
        properties: {},
        additionalProperties: true
      }
    });

    const result = await applyApprovedDiff({
      db: db as never,
      diffId: "diff-3",
      approvalStatus: "auto_approved"
    });

    expect(result.productVersionId).toBeTruthy();
    expect(db._insertedVersions[0].attributesJson).toEqual({
      color: "Black",
      opening_mechanism: "automatic"
    });
    expect(db._insertedVersions[0].categorySchemaVersion).toBe(null);
    expect(db._insertedReviewTasks).toHaveLength(0);
  });
});
```

- [ ] **Step 12.3: Run tests to verify they fail (TDD red phase)**

```bash
bun --cwd packages/catalog/catalog-service test 2>&1 | tail -30
```

Expected: tests fail. The current `applyApprovedDiff` does NOT populate the new columns and does NOT call the validator.

- [ ] **Step 12.4: Commit failing tests**

```bash
git add packages/catalog/catalog-service/src/apply-approved-diff.test.ts packages/catalog/catalog-service/package.json bun.lock
git commit -m "test(catalog-service): failing tests for new canonical columns + validation"
```

---

### Task 13: Rewrite `applyApprovedDiff` (TDD green phase)

**Files:**
- Modify: `packages/catalog/catalog-service/src/index.ts` (the `applyApprovedDiff` function and `CanonicalProductPayload` type)

- [ ] **Step 13.1: Extend `CanonicalProductPayload` with the new fields**

In `packages/catalog/catalog-service/src/index.ts`, update the `CanonicalProductPayload` interface to include the new typed fields. Locate the existing interface (~line 15) and add:

```typescript
export interface CanonicalProductPayload {
  title: string | null;
  brand: string | null;
  gtin: string | null;
  modelNumber: string | null;
  manufacturerPartNumber: string | null;
  description: string | null;
  basePrice: number | null;
  currency: string | null;
  weightGrams: number | null;
  dimensionsCm: { l?: number; w?: number; h?: number } | null;
  canonicalCategory: string | null;
  categorySchemaVersion: string | null;
  categoryConfidence: number | null;
  images: Array<{ url: string; altText?: string }>;
  attributes: Record<string, unknown>;
  variants: Array<{
    sku: string | null;
    barcode: string | null;
    price: number | null;
    currency: string | null;
    inventoryQuantity: number | null;
    optionValues: Record<string, string>;
  }>;
  evidence: Record<string, unknown>;
}
```

- [ ] **Step 13.2: Rewrite the `applyApprovedDiff` function**

Replace the existing `applyApprovedDiff` (currently around lines 42–155) with:

```typescript
import { validate, type ValidationOutcome } from "@aonex/schema-validator";
// ... existing imports

export async function applyApprovedDiff(input: {
  db: DrizzleClient;
  diffId: string;
  approvalStatus: "approved" | "auto_approved";
}): Promise<{
  productId: string;
  productVersionId: string;
  createdVersion: boolean;
}> {
  // 1. Load the diff
  const diff = await input.db.query.proposedDiffs.findFirst({
    where: (d, { eq }) => eq(d.id, input.diffId)
  });
  if (!diff) throw new Error(`Proposed diff not found: ${input.diffId}`);

  // 2. Parse the canonical payload from diff.diffPayload
  const payload = coercePayload(diff.diffPayload as Record<string, unknown>);

  // 3. Load the category schema (if a path was assigned)
  const categorySchemaRow = payload.canonicalCategory
    ? await input.db.query.categorySchemas.findFirst({
        where: (c, { eq }) => eq(c.categoryPath, payload.canonicalCategory!),
        orderBy: (c, { desc }) => [desc(c.schemaVersion)]
      })
    : null;

  // 4. Validate attributes_json against the schema (Tier 1 strict; Tier 2 permissive)
  if (categorySchemaRow?.jsonSchema && categorySchemaRow.tier === "authoritative") {
    const outcome: ValidationOutcome = validate(
      categorySchemaRow.jsonSchema as Record<string, unknown>,
      payload.attributes
    );
    if (!outcome.valid) {
      await emitMissingRequiredReviewTask({
        db: input.db,
        diff,
        outcome,
        categorySchemaRow
      });
      throw new Error(
        `Validation failed for ${payload.canonicalCategory}: missing required = ${outcome.missingRequired.join(", ")}`
      );
    }
  }

  // 5. Create (or reuse) the product identity
  let productId = diff.productId as string | null;
  if (!productId) {
    const [product] = await input.db
      .insert(schema.products)
      .values({
        tenantId: diff.tenantId,
        merchantId: diff.merchantId,
        canonicalCategory: payload.canonicalCategory,
        status: "active"
      })
      .returning({ id: schema.products.id });
    if (!product) throw new Error("Failed to create product");
    productId = product.id;
  }

  // 6. Insert the immutable product_version with all new columns populated
  const [version] = await input.db
    .insert(schema.productVersions)
    .values({
      productId,
      tenantId: diff.tenantId,
      merchantId: diff.merchantId,
      proposedDiffId: input.diffId,
      title: payload.title ?? "",
      brand: payload.brand,
      gtin: payload.gtin,
      modelNumber: payload.modelNumber,
      manufacturerPartNumber: payload.manufacturerPartNumber,
      basePrice: payload.basePrice == null ? null : String(payload.basePrice),
      currency: payload.currency,
      weightGrams: payload.weightGrams == null ? null : String(payload.weightGrams),
      dimensionsCm: payload.dimensionsCm,
      images: payload.images,
      description: payload.description,
      canonicalCategory: payload.canonicalCategory,
      categorySchemaVersion:
        categorySchemaRow?.tier === "authoritative"
          ? `${payload.canonicalCategory}/v${categorySchemaRow.schemaVersion}`
          : null,
      categoryConfidence:
        payload.categoryConfidence == null ? null : String(payload.categoryConfidence),
      attributesJson: payload.attributes,
      confidenceScore: String(diff.confidenceScore),
      merchantExtensionsJson: null,
      evidenceSummary: payload.evidence
    })
    .returning({ id: schema.productVersions.id });

  if (!version) throw new Error("Failed to create product version");

  // 7. Update the product's current_version_id pointer
  await input.db
    .update(schema.products)
    .set({
      currentVersionId: version.id,
      canonicalCategory: payload.canonicalCategory,
      status: "active",
      updatedAt: new Date()
    })
    .where(eq(schema.products.id, productId));

  // 8. Identities + variants — call existing helpers (unchanged)
  await persistIdentities(input.db, diff.tenantId, productId, payload);
  await persistVariants(input.db, diff.tenantId, productId, version.id, payload);

  return { productId, productVersionId: version.id, createdVersion: true };
}

async function emitMissingRequiredReviewTask(args: {
  db: DrizzleClient;
  diff: { id: string; tenantId: string; merchantId: string };
  outcome: ValidationOutcome;
  categorySchemaRow: { categoryPath: string; schemaVersion: number };
}): Promise<void> {
  await args.db.insert(schema.reviewTasks).values({
    tenantId: args.diff.tenantId,
    merchantId: args.diff.merchantId,
    proposedDiffId: args.diff.id,
    taskType: "missing_required_attribute",
    severity: "medium",
    reason: `Tier 1 category ${args.categorySchemaRow.categoryPath} requires ${args.outcome.missingRequired.join(", ")} but they were not extracted`,
    contextJson: {
      categoryPath: args.categorySchemaRow.categoryPath,
      schemaVersion: args.categorySchemaRow.schemaVersion,
      missingRequired: args.outcome.missingRequired,
      validationErrors: args.outcome.errors
    }
  });
}

function coercePayload(raw: Record<string, unknown>): CanonicalProductPayload {
  // Defensive: pull every field from raw with sensible defaults.
  // The semantic mapper and applyApprovedDiff caller are expected to produce a
  // well-formed payload, but tolerate partial inputs for backwards compat with
  // existing proposed_diffs that pre-date Phase 1.
  return {
    title: stringOrNull(raw.title),
    brand: stringOrNull(raw.brand),
    gtin: stringOrNull(raw.gtin),
    modelNumber: stringOrNull(raw.modelNumber),
    manufacturerPartNumber: stringOrNull(raw.manufacturerPartNumber),
    description: stringOrNull(raw.description),
    basePrice: numberOrNull(raw.basePrice),
    currency: stringOrNull(raw.currency),
    weightGrams: numberOrNull(raw.weightGrams),
    dimensionsCm: (raw.dimensionsCm as CanonicalProductPayload["dimensionsCm"]) ?? null,
    canonicalCategory: stringOrNull(raw.canonicalCategory ?? raw.canonical_category),
    categorySchemaVersion: stringOrNull(raw.categorySchemaVersion),
    categoryConfidence: numberOrNull(raw.categoryConfidence),
    images: parseImages(raw.images),
    attributes: isRecord(raw.attributes) ? (raw.attributes as Record<string, unknown>) : {},
    variants: parseVariants(raw.variants),
    evidence: isRecord(raw.evidence) ? (raw.evidence as Record<string, unknown>) : {}
  };
}

// (stringOrNull, numberOrNull, isRecord, parseImages, parseVariants — keep existing helpers
// from the file; if absent, add minimal versions here)
```

- [ ] **Step 13.3: Run the catalog-service tests**

```bash
bun --cwd packages/catalog/catalog-service test 2>&1 | tail -20
```

Expected: all 3 tests in `apply-approved-diff.test.ts` pass. If the immutability trigger test (Tier 2 path) fails because `categorySchemaVersion` is `null`, double-check Step 13.2's branch that pins `null` only on Tier 2.

- [ ] **Step 13.4: Run all package tests to confirm no regressions**

```bash
bun test 2>&1 | tail -30
```

Expected: zero new failures vs Step 1.2 baseline.

- [ ] **Step 13.5: Commit**

```bash
git add packages/catalog/catalog-service/src/index.ts
git commit -m "feat(catalog-service): apply Phase 1 canonical schema, validate Tier 1 on approval"
```

---

### Task 14: Write failing test for the backfill job

**Files:**
- Create: `apps/worker/src/jobs/backfill-attributes-json.test.ts`

- [ ] **Step 14.1: Write the failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { backfillAttributesJson } from "./backfill-attributes-json.js";

function makeMockDb(rows: Array<{
  id: string;
  merchantExtensionsJson: { attributes?: Record<string, unknown>; evidence?: Record<string, unknown> } | null;
  attributesJson: Record<string, unknown> | null;
}>) {
  const updates: Array<{ id: string; attributesJson: Record<string, unknown>; evidenceSummary: Record<string, unknown> | null }> = [];
  let nextOffset = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (n: number) => ({
            offset: (o: number) => {
              nextOffset = o + n;
              return Promise.resolve(rows.slice(o, o + n));
            }
          })
        })
      })
    }),
    update: () => ({
      set: (v: { attributesJson: Record<string, unknown>; evidenceSummary?: Record<string, unknown> | null }) => ({
        where: (_w: unknown) => {
          // Capture the row id via a sentinel
          return Promise.resolve();
        }
      })
    }),
    // Test helper to inspect captured updates
    _captureUpdate: (id: string, v: { attributesJson: Record<string, unknown>; evidenceSummary?: Record<string, unknown> | null }) => {
      updates.push({
        id,
        attributesJson: v.attributesJson,
        evidenceSummary: v.evidenceSummary ?? null
      });
    },
    _updates: updates,
    _nextOffset: () => nextOffset
  };
}

describe("backfillAttributesJson", () => {
  it("migrates merchant_extensions_json.attributes into attributes_json in dry-run mode (no writes)", async () => {
    const db = makeMockDb([
      {
        id: "v1",
        merchantExtensionsJson: {
          attributes: { color: "Red", material: "cotton" },
          evidence: { sourceUrl: "https://example.com/p1" }
        },
        attributesJson: null
      },
      {
        id: "v2",
        merchantExtensionsJson: { attributes: { ram_gb: 8 } },
        attributesJson: null
      }
    ]);

    const result = await backfillAttributesJson({
      db: db as never,
      dryRun: true,
      chunkSize: 10
    });

    expect(result.examined).toBe(2);
    expect(result.wouldUpdate).toBe(2);
    expect(result.updated).toBe(0);    // dry-run does not write
  });

  it("skips rows that already have a non-empty attributes_json", async () => {
    const db = makeMockDb([
      {
        id: "v1",
        merchantExtensionsJson: { attributes: { color: "Red" } },
        attributesJson: { capacity_persons: 2 }    // already populated — skip
      }
    ]);

    const result = await backfillAttributesJson({
      db: db as never,
      dryRun: false,
      chunkSize: 10
    });

    expect(result.examined).toBe(1);
    expect(result.wouldUpdate).toBe(0);
  });

  it("skips rows where merchant_extensions_json has no attributes key", async () => {
    const db = makeMockDb([
      {
        id: "v1",
        merchantExtensionsJson: { evidence: { x: 1 } },    // no .attributes
        attributesJson: null
      }
    ]);

    const result = await backfillAttributesJson({
      db: db as never,
      dryRun: false,
      chunkSize: 10
    });

    expect(result.wouldUpdate).toBe(0);
  });
});
```

- [ ] **Step 14.2: Run test to confirm it fails**

```bash
bun --cwd apps/worker test 2>&1 | grep -A2 backfill | tail -10
```

Expected: "Cannot find module ./backfill-attributes-json.js" or similar.

- [ ] **Step 14.3: Commit failing test**

```bash
git add apps/worker/src/jobs/backfill-attributes-json.test.ts
git commit -m "test(worker): failing test for attributes_json backfill"
```

---

### Task 15: Implement the backfill job (TDD green phase)

**Files:**
- Create: `apps/worker/src/jobs/backfill-attributes-json.ts`

- [ ] **Step 15.1: Write the backfill implementation**

```typescript
// Spec §16 — chunked migration of merchant_extensions_json.attributes
// → product_versions.attributes_json for already-approved versions.
//
// Idempotent: only updates rows where attributes_json IS NULL or '{}'.
// Dry-run mode returns counts without writing.

import { schema, type DrizzleClient } from "@aonex/db";
import { sql, eq, isNull, or } from "drizzle-orm";

export interface BackfillResult {
  examined: number;
  wouldUpdate: number;
  updated: number;
  errors: Array<{ id: string; error: string }>;
}

export interface BackfillOptions {
  db: DrizzleClient;
  dryRun: boolean;
  chunkSize: number;
}

export async function backfillAttributesJson(opts: BackfillOptions): Promise<BackfillResult> {
  const result: BackfillResult = {
    examined: 0,
    wouldUpdate: 0,
    updated: 0,
    errors: []
  };

  let offset = 0;
  // Scan all product_versions where attributes_json is empty AND there are extensions to migrate.
  // Loop until a page returns < chunkSize rows.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await opts.db
      .select({
        id: schema.productVersions.id,
        merchantExtensionsJson: schema.productVersions.merchantExtensionsJson,
        attributesJson: schema.productVersions.attributesJson
      })
      .from(schema.productVersions)
      .where(
        or(
          isNull(schema.productVersions.attributesJson),
          eq(schema.productVersions.attributesJson, {} as never)
        )
      )
      .limit(opts.chunkSize)
      .offset(offset);

    if (rows.length === 0) break;

    for (const row of rows) {
      result.examined++;
      const ext = row.merchantExtensionsJson as
        | { attributes?: Record<string, unknown>; evidence?: Record<string, unknown> }
        | null;

      const attrs = ext?.attributes;
      const existingAttrs = row.attributesJson as Record<string, unknown> | null;
      if (existingAttrs && Object.keys(existingAttrs).length > 0) continue;
      if (!attrs || typeof attrs !== "object" || Object.keys(attrs).length === 0) continue;

      result.wouldUpdate++;

      if (opts.dryRun) continue;

      try {
        await opts.db
          .update(schema.productVersions)
          .set({
            attributesJson: attrs,
            evidenceSummary: ext.evidence ?? null
          })
          .where(eq(schema.productVersions.id, row.id));
        result.updated++;
      } catch (err) {
        result.errors.push({
          id: row.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    offset += opts.chunkSize;
    if (rows.length < opts.chunkSize) break;
  }

  return result;
}
```

- [ ] **Step 15.2: Run tests to verify they pass**

```bash
bun --cwd apps/worker test 2>&1 | tail -20
```

Expected: backfill tests pass.

- [ ] **Step 15.3: Commit**

```bash
git add apps/worker/src/jobs/backfill-attributes-json.ts
git commit -m "feat(worker): backfill job — merchant_extensions_json.attributes → attributes_json"
```

---

### Task 16: Register backfill job in the worker job registry

**Files:**
- Modify: `apps/worker/src/jobs/index.ts`

- [ ] **Step 16.1: Add backfill registration**

Open `apps/worker/src/jobs/index.ts` and add to the exports/registration block:

```typescript
export { backfillAttributesJson } from "./backfill-attributes-json.js";
```

Locate the cron registration section (where `domain-profile-refresh`, `failure-pattern-rollup`, etc. are wired) and add:

```typescript
// One-shot backfill — not a recurring cron. Run via:
//   bun --bun --cwd apps/worker scripts/run-backfill.ts
// or via the BullMQ admin UI. Not scheduled here.
```

(No cron registration — this is a one-shot operation.)

- [ ] **Step 16.2: Create a CLI runner script**

`apps/worker/scripts/run-backfill.ts`:

```typescript
#!/usr/bin/env bun
// Run: bun --bun apps/worker/scripts/run-backfill.ts [--dry-run]
import { createDrizzleClient } from "@aonex/db";
import { backfillAttributesJson } from "../src/jobs/backfill-attributes-json.js";

const dryRun = process.argv.includes("--dry-run");
const db = createDrizzleClient({ connectionString: process.env.DATABASE_URL! });

const result = await backfillAttributesJson({
  db,
  dryRun,
  chunkSize: 200
});

// eslint-disable-next-line no-console
console.log(JSON.stringify(result, null, 2));
process.exit(0);
```

If `createDrizzleClient` doesn't exist in `@aonex/db`, replace with the existing client factory — check `packages/db/src/client.ts` for the actual export name.

- [ ] **Step 16.3: Commit**

```bash
git add apps/worker/src/jobs/index.ts apps/worker/scripts/run-backfill.ts
git commit -m "feat(worker): register backfill job + CLI runner"
```

---

### Task 17: Run backfill in dry-run on local dev DB

**Files:** none (operational)

- [ ] **Step 17.1: Run dry-run**

```bash
bun --bun apps/worker/scripts/run-backfill.ts --dry-run
```

Expected output:

```json
{
  "examined": N,
  "wouldUpdate": M,
  "updated": 0,
  "errors": []
}
```

Where `N` and `M` reflect how many existing approved versions have `merchant_extensions_json.attributes`. On a fresh dev DB with no prior data, both will be 0.

- [ ] **Step 17.2: If any errors surface, investigate before live run**

If `errors` is non-empty, examine the error messages, fix the underlying issue (likely a column-name mismatch from Step 13.2), commit the fix, and re-run dry-run.

- [ ] **Step 17.3: Run live backfill**

```bash
bun --bun apps/worker/scripts/run-backfill.ts
```

Expected: `updated` equals the prior `wouldUpdate`, `errors` empty.

- [ ] **Step 17.4: Verify migrated rows in psql**

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM product_versions WHERE attributes_json IS NOT NULL AND attributes_json != '{}'::jsonb;"
```

Expected: count matches `updated` from Step 17.3.

---

### Task 18: End-to-end smoke test — submit a link, verify new canonical row

**Files:** none (manual smoke; see Phase 6 for automated E2E)

- [ ] **Step 18.1: Start the local stack**

```bash
docker compose up -d postgres redis
bun --bun --cwd apps/api dev &
bun --bun --cwd apps/worker dev &
```

Wait for both to log "ready".

- [ ] **Step 18.2: Seed a Tier 1 category schema for tents**

```bash
psql "$DATABASE_URL" <<SQL
INSERT INTO category_schemas (category_path, schema_version, json_schema, required_attributes, tier, display_name)
VALUES (
  'outdoor/camping/tents',
  1,
  '{"tier": "authoritative", "type": "object", "required": ["capacity_persons", "season_rating", "packed_weight_grams", "peak_height_cm", "waterproof_rating_mm"], "properties": {"capacity_persons": {"type": "integer"}, "season_rating": {"type": "string", "enum": ["3-season", "4-season"]}, "packed_weight_grams": {"type": "number"}, "peak_height_cm": {"type": "number"}, "waterproof_rating_mm": {"type": "number"}}}'::jsonb,
  ARRAY['capacity_persons', 'season_rating', 'packed_weight_grams', 'peak_height_cm', 'waterproof_rating_mm'],
  'authoritative',
  'Tents'
)
ON CONFLICT (category_path, schema_version) DO NOTHING;
SQL
```

- [ ] **Step 18.3: Submit a link extraction job** (requires the rest of the pipeline to be running)

```bash
curl -X POST http://localhost:8787/api/ingestions/link \
  -H "Authorization: Bearer $TEST_JWT" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.decathlon.com/products/2-person-tent-mh100-fresh-and-black-quechua/_/R-p-308466", "category_hint": "outdoor/camping/tents"}'
```

Expected: 202 Accepted with `ingestion_id`.

- [ ] **Step 18.4: Wait for extraction to complete; inspect the resulting row**

```bash
sleep 30
psql "$DATABASE_URL" -c "SELECT title, brand, category_schema_version, attributes_json FROM product_versions ORDER BY created_at DESC LIMIT 1;"
```

Expected: a row with `attributes_json` containing extracted tent attributes (or a `review_task` if validator opened one). If `attributes_json` is `{}`, examine the most-recent `audit_events` for clues — most likely the semantic mapper or the link processor isn't producing the `attributes` field in its `diffPayload`. That's a Phase 2 problem; for Phase 1 acceptance, it's enough that the schema accepts the data when present.

- [ ] **Step 18.5: Commit no code, just record results**

Capture the row contents and add to the PR description.

---

### Task 19: Update the .env.example with no-op note + push branch

**Files:**
- Modify: `.env.example`

- [ ] **Step 19.1: Add a comment block at the bottom of `.env.example`**

```bash
cat >> .env.example <<'EOF'

# Phase 1 — Canonical schema fix
# No new env vars added in Phase 1 (validator is library-only).
# Backfill is run via: bun --bun apps/worker/scripts/run-backfill.ts [--dry-run]
EOF
```

- [ ] **Step 19.2: Commit**

```bash
git add .env.example
git commit -m "docs: note Phase 1 has no new env vars; backfill runner instructions"
```

- [ ] **Step 19.3: Push branch and open PR**

```bash
git push -u origin feature/phase-1-canonical-schema
gh pr create \
  --title "feat(phase-1): canonical schema fix" \
  --body "$(cat <<'BODY'
## Summary
- Adds 7 new columns to `product_versions` per HLD §8.1: `manufacturer_part_number`, `weight_grams`, `dimensions_cm`, `category_schema_version`, `category_confidence`, `attributes_json`, `evidence_summary`
- Adds `tier`, `parent_path`, `display_name`, `active` to `category_schemas`
- Creates `category_labels`, `tenant_category_overlays`, `category_attribute_promotion_candidates` tables
- New `@aonex/schema-validator` package (Ajv 8 + JSON Schema 2019-09 + Aonex `tier` / `confidence_required` keywords)
- Rewrites `applyApprovedDiff` to populate `attributes_json` properly (no longer stuffed in `merchant_extensions_json`); calls validator pre-insert; emits `missing_required_attribute` review task on Tier 1 misses
- Chunked backfill job for existing `merchant_extensions_json.attributes` → `attributes_json`
- GIN index on `attributes_json` for jsonb query performance

## Test plan
- [ ] CI green on baseline before merge
- [ ] `bun --cwd packages/schema-validator test` all green (3 describe blocks, 8+ assertions)
- [ ] `bun --cwd packages/catalog/catalog-service test` all green (apply-approved-diff.test.ts)
- [ ] `bun --cwd apps/worker test` all green (backfill-attributes-json.test.ts)
- [ ] Existing `sync-service.test.ts` + `link-catalog-pipeline.test.ts` still pass
- [ ] Dry-run backfill on local dev DB completes without errors
- [ ] Live backfill writes expected counts
- [ ] Smoke test: link extraction produces `product_versions.attributes_json` non-empty for tent URL

## Spec
docs/superpowers/specs/2026-05-16-unified-ingestion-design.md (commit 217cedb)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Self-Review

1. **Spec coverage** — Phase 1 acceptance from the spec was: migrations apply, `applyApprovedDiff` populates `attributes_json` + 6 new columns, validator opens `missing_required_attribute` review task for Tier 1 misses, existing fixtures still process, backfill dry-run completes without error. Tasks 1–19 cover every item: Tasks 2–8 = migrations; Tasks 9–13 = validator + applyApprovedDiff rewrite; Tasks 14–17 = backfill; Task 18 = smoke. ✓

2. **Placeholder scan** — No "TBD", "TODO", "implement later", or "Similar to Task N" present. Two acceptable forward references: Task 18.4 notes "that's a Phase 2 problem" (legitimate phase boundary), and Task 16.2 mentions checking `packages/db/src/client.ts` for the actual export name (defensive guidance against codebase drift). ✓

3. **Type consistency** — `CanonicalProductPayload` in Task 13.1 carries `attributes` (not `attributes_json`) at the *payload* level and `attributesJson` (camelCase) at the *Drizzle row* level. `applyApprovedDiff` test in Task 12 uses both consistently. `ValidationOutcome.missingRequired` is `string[]` everywhere. `tier` is `"authoritative" | "inferred" | "promoted_draft"` in both `types.ts` and the test fixtures. ✓

4. **Sequencing** — Drizzle TS edits (Tasks 2–6) precede `drizzle-kit generate` (Task 7); validator skeleton (Task 9) precedes failing test (Task 10) precedes implementation (Task 11); failing test (Task 12) precedes rewrite (Task 13); same TDD pattern for backfill (Tasks 14–15). ✓

Fixes applied during review: none required.

---

## Phase boundary

Phase 1 leaves the system in a state where:
- Canonical schema columns exist and are nullable (expand-contract step 1)
- `applyApprovedDiff` populates them when the diff payload carries them
- Validator runs and gates Tier 1 approvals
- Existing data is backfilled

It does NOT yet:
- Refactor the link extractor onto a unified `IngestionAdapter` spine (Phase 2)
- LLM-draft the 150 seed schemas (Phase 3)
- Build the CSV lane (Phase 4)

Phase 2 begins with the assumption that `attributes_json` is populated and the validator works.
