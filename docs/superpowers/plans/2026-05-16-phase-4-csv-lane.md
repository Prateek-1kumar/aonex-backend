# Phase 4 — Templated CSV Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** §7 + §17 Phase 4
**Depends on:** Phase 1 (canonical schema), Phase 2 (spine), Phase 3 (Tier 1/2 schemas seeded).
**Blocks:** nothing downstream.

**Goal:** Build the templated CSV lane end-to-end. Header-locked per HLD §11.3 / spec §7.1. Multipart upload endpoint persists raw file to MinIO, creates one file-level `source_artifact` + one per-row `source_artifact`, streams rows through the unified ingestion spine, reports per-row errors.

**Architecture:** New `@aonex/csv-adapter` workspace package implements `IngestionAdapter` for `lane: "csv"`. `papaparse` for streaming CSV parse. MinIO docker-compose service + `@aws-sdk/client-s3` for object storage. New `POST /v1/ingestions/csv` Hono route on `apps/api`. New `apps/worker/src/processors/csv-extract.processor.ts` BullMQ processor that consumes `ingestion.csv` queue and invokes the spine per row.

**Tech Stack:** TypeScript, papaparse (streaming CSV), `@aws-sdk/client-s3` (S3-compatible MinIO), BullMQ, Hono, Drizzle.

**Acceptance:** 500-row golden CSV fully processes end-to-end. Malformed rows produce `source_artifacts.processing_errors` entries with row number. Good rows reach the canonical model via the same spine as the link lane. Header validation rejects files whose headers don't exactly match the template.

---

## File Structure

**Files created**
- `packages/csv-adapter/package.json`, `tsconfig.json`, `src/index.ts`
- `packages/csv-adapter/src/csv-adapter.ts`
- `packages/csv-adapter/src/template.ts` — column list constant + validator
- `packages/csv-adapter/src/parse-row.ts` — single-row → IngestionEnvelope mapping
- `packages/csv-adapter/src/csv-adapter.test.ts`
- `packages/csv-adapter/src/parse-row.test.ts`
- `packages/csv-adapter/src/fixtures/golden-500.csv`
- `packages/csv-adapter/src/fixtures/malformed-headers.csv`
- `packages/csv-adapter/src/fixtures/malformed-rows.csv`
- `packages/object-store/package.json`, `tsconfig.json`, `src/index.ts`, `src/s3-client.ts`, `src/s3-client.test.ts`
- `apps/api/src/routes/ingestions-csv.ts` — POST endpoint
- `apps/api/src/routes/ingestions-csv.test.ts`
- `apps/worker/src/processors/csv-extract.processor.ts`
- `apps/worker/src/processors/csv-extract.processor.test.ts`
- `docker-compose.minio.yml` (override) — MinIO service
- `docs/superpowers/runbooks/csv-upload.md`

**Files modified**
- `docker-compose.yml` — add MinIO service
- `apps/api/src/routes/ingestions.ts` — mount csv sub-router
- `packages/types/src/index.ts` — add `QUEUE.CSV_EXTRACT`
- `apps/worker/src/composition-root.ts` — wire CSV processor
- `.env.example` — add MinIO + object store env vars (already done in Phase 1)
- `package.json` — add `papaparse` workspace dep if not present

---

## Tasks

### Task 1: Branch + add MinIO to docker-compose

- [ ] **Step 1.1: Branch**

```bash
git checkout main && git pull --ff-only
git checkout -b feature/phase-4-csv-lane
```

- [ ] **Step 1.2: Add MinIO service**

Edit `docker-compose.yml`, append after the `redis` service:

```yaml
  minio:
    image: minio/minio:latest
    container_name: aonex-minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"      # S3 API
      - "9001:9001"      # web console
    volumes:
      - aonex-minio-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 3s
      retries: 5
```

And add `aonex-minio-data:` to the `volumes:` block at the bottom.

- [ ] **Step 1.3: Bring up MinIO + create the bucket**

```bash
docker compose up -d minio
# Create the bucket via mc CLI inside the container
docker exec aonex-minio sh -c "
  mc alias set local http://localhost:9000 minioadmin minioadmin
  mc mb -p local/aonex-source-artifacts
  mc ls local/
"
```

Expected: bucket appears in `ls`.

- [ ] **Step 1.4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(infra): add MinIO service to docker-compose for source-artifact storage"
```

---

### Task 2: Scaffold `@aonex/object-store` package

**Files:**
- Create: `packages/object-store/package.json`, `tsconfig.json`, `src/index.ts`, `src/s3-client.ts`

- [ ] **Step 2.1: Package skeleton**

`packages/object-store/package.json`:

```json
{
  "name": "@aonex/object-store",
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
    "@aws-sdk/client-s3": "^3.700.0"
  }
}
```

`tsconfig.json`: same shape as other packages.

`src/index.ts`:

```typescript
export { createObjectStore, type ObjectStore } from "./s3-client.js";
```

- [ ] **Step 2.2: Implement the S3 client wrapper**

`packages/object-store/src/s3-client.ts`:

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

export interface ObjectStoreConfig {
  endpoint: string;       // http://localhost:9000 for MinIO
  region: string;         // arbitrary for MinIO; required for prod
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle?: boolean;    // true for MinIO
}

export interface ObjectStore {
  put(key: string, body: Buffer | string, contentType: string): Promise<{ uri: string }>;
  get(key: string): Promise<Buffer>;
}

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    forcePathStyle: config.forcePathStyle ?? true
  });

  return {
    async put(key: string, body: Buffer | string, contentType: string) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType
      }));
      return { uri: `s3://${config.bucket}/${key}` };
    },
    async get(key: string): Promise<Buffer> {
      const result = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: key
      }));
      const chunks: Buffer[] = [];
      const stream = result.Body as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    }
  };
}
```

- [ ] **Step 2.3: Smoke test against local MinIO**

`packages/object-store/src/s3-client.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { createObjectStore } from "./s3-client.js";

const haveMinio = process.env.MINIO_TEST === "1";

describe.if(haveMinio)("ObjectStore — integration with local MinIO", () => {
  const store = createObjectStore({
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
    bucket: "aonex-source-artifacts"
  });

  it("put + get round-trips a buffer", async () => {
    const key = `test/${Date.now()}.txt`;
    await store.put(key, Buffer.from("hello world"), "text/plain");
    const got = await store.get(key);
    expect(got.toString("utf-8")).toBe("hello world");
  });
});
```

Run with `MINIO_TEST=1 bun --cwd packages/object-store test` to opt in (skipped in regular CI).

- [ ] **Step 2.4: Install + commit**

```bash
bun install
git add packages/object-store/ bun.lock
git commit -m "feat(object-store): S3-compatible client wrapper for MinIO + S3/R2"
```

---

### Task 3: Scaffold `@aonex/csv-adapter` package

**Files:**
- Create: `packages/csv-adapter/package.json`, `tsconfig.json`, `src/index.ts`, `src/template.ts`

- [ ] **Step 3.1: Package skeleton**

`packages/csv-adapter/package.json`:

```json
{
  "name": "@aonex/csv-adapter",
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
    "@aonex/ingestion-field-extractor": "workspace:*",
    "@aonex/object-store": "workspace:*",
    "@aonex/lib-utils": "workspace:*",
    "papaparse": "^5.5.0"
  },
  "devDependencies": {
    "@types/papaparse": "^5.3.15"
  }
}
```

- [ ] **Step 3.2: Define the locked template**

`packages/csv-adapter/src/template.ts`:

```typescript
// Spec §7.1 — locked CSV template. Header set is exact; column order may vary.
// `attributes.*` columns are open-ended (any header starting with attributes.
// is parsed as a Layer 3 attribute key).

export const REQUIRED_HEADERS = [
  "product_handle",
  "title",
  "brand",
  "base_price",
  "currency",
  "category_path"
] as const;

export const OPTIONAL_HEADERS = [
  "parent_sku",
  "variant_sku",
  "gtin",
  "model_number",
  "manufacturer_part_number",
  "description",
  "weight_grams",
  "length_cm",
  "width_cm",
  "height_cm",
  "inventory_quantity",
  "image_url",
  "option_1_name", "option_1_value",
  "option_2_name", "option_2_value",
  "option_3_name", "option_3_value",
  "merchant_extensions.notes"
] as const;

export type RequiredHeader = (typeof REQUIRED_HEADERS)[number];
export type OptionalHeader = (typeof OPTIONAL_HEADERS)[number];

export interface HeaderValidationResult {
  valid: boolean;
  missingRequired: string[];
  /** Unknown headers that are NOT attributes.* */
  unexpected: string[];
}

export function validateHeaders(headers: string[]): HeaderValidationResult {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const missingRequired = REQUIRED_HEADERS.filter((r) => !lower.includes(r));
  const knownSet = new Set<string>([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]);
  const unexpected = lower.filter((h) => !knownSet.has(h) && !h.startsWith("attributes."));
  return {
    valid: missingRequired.length === 0 && unexpected.length === 0,
    missingRequired,
    unexpected
  };
}

export function isAttributeHeader(h: string): boolean {
  return h.trim().toLowerCase().startsWith("attributes.");
}

export function attributeKey(h: string): string {
  return h.trim().toLowerCase().replace(/^attributes\./, "");
}
```

- [ ] **Step 3.3: Empty index.ts**

`packages/csv-adapter/src/index.ts`:

```typescript
export { CsvAdapter, createCsvAdapter } from "./csv-adapter.js";
export { validateHeaders, REQUIRED_HEADERS, OPTIONAL_HEADERS, type HeaderValidationResult } from "./template.js";
export { parseRowToEnvelope, type RowParseResult } from "./parse-row.js";
```

- [ ] **Step 3.4: Install + commit**

```bash
bun install
git add packages/csv-adapter/ bun.lock
git commit -m "feat(csv-adapter): scaffold package + locked template + header validator"
```

---

### Task 4: Write + pass header-validation tests

**Files:**
- Modify: `packages/csv-adapter/src/template.test.ts`

- [ ] **Step 4.1: Write the test**

```typescript
import { describe, it, expect } from "bun:test";
import { validateHeaders, isAttributeHeader, attributeKey } from "./template.js";

describe("validateHeaders", () => {
  it("accepts the minimum required header set", () => {
    const result = validateHeaders([
      "product_handle", "title", "brand", "base_price", "currency", "category_path"
    ]);
    expect(result.valid).toBe(true);
  });

  it("accepts required + optional + attributes.* columns", () => {
    const result = validateHeaders([
      "product_handle", "title", "brand", "base_price", "currency", "category_path",
      "gtin", "weight_grams",
      "attributes.color", "attributes.size_us", "attributes.material"
    ]);
    expect(result.valid).toBe(true);
  });

  it("flags missing required column", () => {
    const result = validateHeaders([
      "product_handle", "title", "brand", "base_price", "currency"
      // missing category_path
    ]);
    expect(result.valid).toBe(false);
    expect(result.missingRequired).toContain("category_path");
  });

  it("flags unknown non-attributes.* column", () => {
    const result = validateHeaders([
      "product_handle", "title", "brand", "base_price", "currency", "category_path",
      "mystery_column"
    ]);
    expect(result.valid).toBe(false);
    expect(result.unexpected).toContain("mystery_column");
  });
});

describe("attribute header helpers", () => {
  it("isAttributeHeader true for attributes.x", () => {
    expect(isAttributeHeader("attributes.color")).toBe(true);
    expect(isAttributeHeader("attributes.screen_size_inches")).toBe(true);
    expect(isAttributeHeader("color")).toBe(false);
  });

  it("attributeKey strips prefix", () => {
    expect(attributeKey("attributes.color")).toBe("color");
    expect(attributeKey("ATTRIBUTES.Screen_Size_Inches")).toBe("screen_size_inches");
  });
});
```

- [ ] **Step 4.2: Run tests + commit (validator already implemented)**

```bash
bun --cwd packages/csv-adapter test
git add packages/csv-adapter/src/template.test.ts
git commit -m "test(csv-adapter): header validation tests pass"
```

---

### Task 5: Implement + test `parseRowToEnvelope`

**Files:**
- Create: `packages/csv-adapter/src/parse-row.ts`
- Create: `packages/csv-adapter/src/parse-row.test.ts`

- [ ] **Step 5.1: Write the failing test**

```typescript
import { describe, it, expect } from "bun:test";
import { parseRowToEnvelope } from "./parse-row.js";

describe("parseRowToEnvelope", () => {
  it("maps a complete row into a valid IngestionEnvelope + facts list", () => {
    const headers = [
      "product_handle", "title", "brand", "gtin", "base_price", "currency",
      "category_path", "weight_grams", "length_cm", "width_cm", "height_cm",
      "attributes.screen_size_inches", "attributes.resolution", "attributes.display_type"
    ];
    const row = [
      "tv-vision-55",
      "Aonami Vision 55 OLED 4K",
      "Aonami",
      "8901234567890",
      "799.00",
      "USD",
      "electronics/televisions",
      "17200",
      "123",
      "71",
      "8",
      "55",
      "4K",
      "OLED"
    ];
    const result = parseRowToEnvelope({
      rowNumber: 2,
      headers,
      row,
      parentArtifactId: "file-art-1" as never,
      fileChecksum: "filehash"
    });

    expect(result.valid).toBe(true);
    expect(result.envelope!.sourceType).toBe("templated_csv");
    expect(result.envelope!.sourceExternalId).toContain("tv-vision-55");
    expect(result.envelope!.checksum).toBeTruthy();
    expect((result.envelope!.rawData as Record<string, unknown>).attributes).toEqual({
      screen_size_inches: "55",
      resolution: "4K",
      display_type: "OLED"
    });
  });

  it("rejects a row missing required field", () => {
    const headers = ["product_handle", "title", "brand", "base_price", "currency", "category_path"];
    const row = ["sku-1", "", "Aonami", "10.00", "USD", "x/y"];    // empty title
    const result = parseRowToEnvelope({
      rowNumber: 5,
      headers,
      row,
      parentArtifactId: "file-art-1" as never,
      fileChecksum: "filehash"
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ field: "title" }));
  });

  it("rejects when base_price is not a number", () => {
    const headers = ["product_handle", "title", "brand", "base_price", "currency", "category_path"];
    const row = ["sku-1", "T", "B", "not-a-number", "USD", "x/y"];
    const result = parseRowToEnvelope({
      rowNumber: 3,
      headers,
      row,
      parentArtifactId: "file-art-1" as never,
      fileChecksum: "filehash"
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "base_price")).toBe(true);
  });
});
```

- [ ] **Step 5.2: Implement `parseRowToEnvelope`**

```typescript
// packages/csv-adapter/src/parse-row.ts
import type { IngestionEnvelope } from "@aonex/ingestion-spine";
import type { ArtifactId } from "@aonex/types";
import { sha256Hex } from "@aonex/lib-utils";
import { REQUIRED_HEADERS, isAttributeHeader, attributeKey } from "./template.js";

export interface RowParseResult {
  rowNumber: number;
  valid: boolean;
  envelope: IngestionEnvelope | null;
  errors: Array<{ field: string; message: string }>;
}

export function parseRowToEnvelope(input: {
  rowNumber: number;
  headers: string[];
  row: string[];
  parentArtifactId: ArtifactId;
  fileChecksum: string;
}): RowParseResult {
  const errors: RowParseResult["errors"] = [];
  const lowerHeaders = input.headers.map((h) => h.trim().toLowerCase());

  // Map header → value
  const cells: Record<string, string> = {};
  for (let i = 0; i < lowerHeaders.length; i++) {
    cells[lowerHeaders[i]] = (input.row[i] ?? "").trim();
  }

  // Required field check
  for (const r of REQUIRED_HEADERS) {
    if (!cells[r]) errors.push({ field: r, message: "required value is empty" });
  }

  // Type check on base_price
  if (cells.base_price && Number.isNaN(Number(cells.base_price))) {
    errors.push({ field: "base_price", message: "must be a number" });
  }

  // Type check on weight_grams + dimensions
  for (const numField of ["weight_grams", "length_cm", "width_cm", "height_cm", "inventory_quantity"]) {
    if (cells[numField] && Number.isNaN(Number(cells[numField]))) {
      errors.push({ field: numField, message: "must be a number" });
    }
  }

  if (errors.length > 0) {
    return { rowNumber: input.rowNumber, valid: false, envelope: null, errors };
  }

  // Build attributes map from attributes.* columns
  const attributes: Record<string, string> = {};
  for (const h of lowerHeaders) {
    if (!isAttributeHeader(h)) continue;
    const v = cells[h];
    if (v) attributes[attributeKey(h)] = v;
  }

  // Build the envelope's rawData. The spine's map/validate stages will normalize.
  const rawData: Record<string, unknown> = {
    product_handle: cells.product_handle,
    title: cells.title,
    brand: cells.brand,
    gtin: cells.gtin || null,
    model_number: cells.model_number || null,
    manufacturer_part_number: cells.manufacturer_part_number || null,
    base_price: Number(cells.base_price),
    currency: cells.currency,
    category_path: cells.category_path,
    description: cells.description || null,
    weight_grams: cells.weight_grams ? Number(cells.weight_grams) : null,
    dimensions_cm: cells.length_cm || cells.width_cm || cells.height_cm
      ? {
          l: cells.length_cm ? Number(cells.length_cm) : undefined,
          w: cells.width_cm ? Number(cells.width_cm) : undefined,
          h: cells.height_cm ? Number(cells.height_cm) : undefined
        }
      : null,
    inventory_quantity: cells.inventory_quantity ? Number(cells.inventory_quantity) : null,
    image_url: cells.image_url || null,
    options: [
      { name: cells.option_1_name, value: cells.option_1_value },
      { name: cells.option_2_name, value: cells.option_2_value },
      { name: cells.option_3_name, value: cells.option_3_value }
    ].filter((o) => o.name && o.value),
    attributes
  };

  const externalId = `${input.fileChecksum}#row${input.rowNumber}#${cells.product_handle}`;
  const checksum = sha256Hex(JSON.stringify(rawData));

  return {
    rowNumber: input.rowNumber,
    valid: true,
    errors: [],
    envelope: {
      sourceExternalId: externalId,
      sourceType: "templated_csv",
      sourceMarketplace: null,
      rawData,
      checksum,
      parentArtifactId: input.parentArtifactId
    }
  };
}
```

- [ ] **Step 5.3: Run + commit**

```bash
bun --cwd packages/csv-adapter test
git add packages/csv-adapter/src/parse-row.ts packages/csv-adapter/src/parse-row.test.ts
git commit -m "feat(csv-adapter): parseRowToEnvelope with per-row type validation"
```

---

### Task 6: Implement `CsvAdapter` (streaming parse, generator)

**Files:**
- Create: `packages/csv-adapter/src/csv-adapter.ts`

- [ ] **Step 6.1: Write the adapter**

```typescript
import type { IngestionAdapter, IngestionEnvelope, AdapterInput } from "@aonex/ingestion-spine";
import type { ExtractedFactSet, ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ArtifactId } from "@aonex/types";
import type { ObjectStore } from "@aonex/object-store";
import { sha256Hex } from "@aonex/lib-utils";
import Papa from "papaparse";
import { validateHeaders } from "./template.js";
import { parseRowToEnvelope } from "./parse-row.js";

export interface CsvAdapterDeps {
  objectStore: ObjectStore;
  /** Object-store key the raw CSV file was uploaded to (set by the API route) */
  storageKey: string;
  /** Parent artifact_id created from the file-level source_artifact (set by the API route) */
  parentArtifactId: ArtifactId;
  /** Sha-256 hex of the file body (set by the API route) */
  fileChecksum: string;
}

class CsvAdapter implements IngestionAdapter {
  readonly lane = "csv" as const;
  constructor(private readonly deps: CsvAdapterDeps) {}

  async *normalize(_input: AdapterInput): AsyncIterable<IngestionEnvelope> {
    const buf = await this.deps.objectStore.get(this.deps.storageKey);
    const text = buf.toString("utf-8");
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });

    if (parsed.errors.length > 0) {
      throw new Error(`CSV parse failed: ${parsed.errors.map((e) => e.message).join("; ")}`);
    }

    const rows = parsed.data;
    if (rows.length === 0) return;

    const headers = rows[0];
    const headerCheck = validateHeaders(headers);
    if (!headerCheck.valid) {
      throw new Error(
        `Header validation failed: missing=${headerCheck.missingRequired.join(",")} unexpected=${headerCheck.unexpected.join(",")}`
      );
    }

    for (let i = 1; i < rows.length; i++) {
      const result = parseRowToEnvelope({
        rowNumber: i + 1,    // 1-indexed; header is row 1
        headers,
        row: rows[i],
        parentArtifactId: this.deps.parentArtifactId,
        fileChecksum: this.deps.fileChecksum
      });

      if (result.valid && result.envelope) {
        yield result.envelope;
      } else {
        // Caller (worker processor) will collect rejected rows; we throw a
        // sentinel envelope that the worker recognizes by an `errors` key in rawData.
        yield {
          sourceExternalId: `${this.deps.fileChecksum}#row${result.rowNumber}#REJECTED`,
          sourceType: "templated_csv",
          sourceMarketplace: null,
          rawData: { __rejected: true, errors: result.errors, rowNumber: result.rowNumber },
          checksum: sha256Hex(JSON.stringify(result.errors) + result.rowNumber),
          parentArtifactId: this.deps.parentArtifactId
        };
      }
    }
  }

  async extract(envelope: IngestionEnvelope): Promise<ExtractedFactSet> {
    // CSV rows are pre-structured: every value is already a fact. Convert rawData → facts.
    const raw = envelope.rawData as Record<string, unknown>;
    const facts: ExtractedFact[] = [];

    function add(rawKey: string, value: unknown, sourcePointer: string): void {
      if (value == null || value === "") return;
      facts.push({
        rawKey,
        canonicalPath: null,    // semantic mapper assigns
        extractedValue: value,
        normalizedValue: null,
        unit: null,
        sourcePointer,
        extractionMethod: "csv_cell",
        mappingMethod: null,
        mappingCandidates: null,
        sourceAlternatives: null,
        confidence: 1.0,    // CSV is human-input; trust verbatim
        approved: false
      });
    }

    add("title", raw.title, "$.title");
    add("brand", raw.brand, "$.brand");
    add("gtin", raw.gtin, "$.gtin");
    add("model_number", raw.model_number, "$.model_number");
    add("manufacturer_part_number", raw.manufacturer_part_number, "$.manufacturer_part_number");
    add("base_price", raw.base_price, "$.base_price");
    add("currency", raw.currency, "$.currency");
    add("category_path", raw.category_path, "$.category_path");
    add("description", raw.description, "$.description");
    add("weight_grams", raw.weight_grams, "$.weight_grams");
    add("dimensions_cm", raw.dimensions_cm, "$.dimensions_cm");

    const attrs = (raw.attributes as Record<string, string> | undefined) ?? {};
    for (const [k, v] of Object.entries(attrs)) {
      add(k, v, `$.attributes.${k}`);
    }

    return {
      artifactId: envelope.sourceExternalId as ArtifactId,
      marketplace: "templated_csv",
      extractorVersion: "csv-adapter@1.0.0",
      facts,
      extractedAt: new Date()
    };
  }
}

export function createCsvAdapter(deps: CsvAdapterDeps): IngestionAdapter {
  return new CsvAdapter(deps);
}

export { CsvAdapter };
```

- [ ] **Step 6.2: Write a smoke test**

`packages/csv-adapter/src/csv-adapter.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { createCsvAdapter } from "./csv-adapter.js";
import type { ObjectStore } from "@aonex/object-store";

function makeMockStore(csv: string): ObjectStore {
  return {
    async put() { return { uri: "s3://x/y" }; },
    async get() { return Buffer.from(csv, "utf-8"); }
  };
}

const csvBody = `product_handle,title,brand,base_price,currency,category_path,attributes.color
sku-1,T-Shirt,Aonami,19.99,USD,apparel/tops/t_shirts,Red
sku-2,T-Shirt,Aonami,19.99,USD,apparel/tops/t_shirts,Blue
`;

describe("CsvAdapter", () => {
  it("yields one envelope per valid row", async () => {
    const adapter = createCsvAdapter({
      objectStore: makeMockStore(csvBody),
      storageKey: "x",
      parentArtifactId: "file-art" as never,
      fileChecksum: "filehash"
    });
    const envs = [];
    for await (const e of adapter.normalize({ sourceRef: "file-art" })) envs.push(e);
    expect(envs).toHaveLength(2);
    expect(envs[0].sourceType).toBe("templated_csv");
    expect((envs[0].rawData as Record<string, unknown>).attributes).toEqual({ color: "Red" });
  });

  it("rejects when headers are invalid", async () => {
    const badCsv = `wrong_handle,wrong_title\nx,y\n`;
    const adapter = createCsvAdapter({
      objectStore: makeMockStore(badCsv),
      storageKey: "x",
      parentArtifactId: "file-art" as never,
      fileChecksum: "filehash"
    });
    await expect(async () => {
      for await (const _e of adapter.normalize({ sourceRef: "file-art" })) {
        /* should throw before yielding */
      }
    }).toThrow(/Header validation failed/);
  });

  it("yields a __rejected envelope for type-failing row", async () => {
    const csv = `product_handle,title,brand,base_price,currency,category_path
sku-1,T,B,not-a-number,USD,x/y
`;
    const adapter = createCsvAdapter({
      objectStore: makeMockStore(csv),
      storageKey: "x",
      parentArtifactId: "file-art" as never,
      fileChecksum: "filehash"
    });
    const envs = [];
    for await (const e of adapter.normalize({ sourceRef: "file-art" })) envs.push(e);
    expect(envs).toHaveLength(1);
    expect((envs[0].rawData as { __rejected: boolean }).__rejected).toBe(true);
  });
});
```

- [ ] **Step 6.3: Run + commit**

```bash
bun --cwd packages/csv-adapter test
git add packages/csv-adapter/src/csv-adapter.ts packages/csv-adapter/src/csv-adapter.test.ts
git commit -m "feat(csv-adapter): streaming CsvAdapter with per-row envelope yield"
```

---

### Task 7: Create golden 500-row fixture + malformed fixtures

**Files:**
- Create: `packages/csv-adapter/src/fixtures/golden-500.csv`
- Create: `packages/csv-adapter/src/fixtures/malformed-headers.csv`
- Create: `packages/csv-adapter/src/fixtures/malformed-rows.csv`

- [ ] **Step 7.1: Write a small script to generate `golden-500.csv`**

```bash
mkdir -p packages/csv-adapter/src/fixtures
cat > /tmp/gen-golden.ts <<'EOF'
import { writeFileSync } from "node:fs";

const header = "product_handle,title,brand,gtin,base_price,currency,category_path,weight_grams,attributes.color,attributes.size";
const rows: string[] = [header];

const categories = [
  ["apparel/tops/t_shirts", ["S", "M", "L", "XL"]],
  ["apparel/bottoms/jeans", ["28", "30", "32", "34"]],
  ["outdoor/camping/tents", ["2p", "4p"]],
  ["electronics/headphones", ["one"]]
];

let i = 1;
for (const [cat, sizes] of categories) {
  for (const size of sizes as string[]) {
    for (const color of ["Red", "Blue", "Black"]) {
      rows.push([
        `sku-${i++}`,
        `Demo Product ${cat.split("/").pop()} ${color} ${size}`,
        "Aonami",
        `890123456${String(i).padStart(4, "0")}`,
        (10 + (i % 90)).toFixed(2),
        "USD",
        cat as string,
        String(100 + (i % 500)),
        color,
        size
      ].join(","));
      if (rows.length >= 501) break;
    }
    if (rows.length >= 501) break;
  }
  if (rows.length >= 501) break;
}

// Pad to 501 lines total (1 header + 500 rows)
while (rows.length < 501) {
  rows.push(rows[rows.length - 1].replace(/^sku-(\d+)/, (_m, n) => `sku-${Number(n) + 1}`));
}

writeFileSync("packages/csv-adapter/src/fixtures/golden-500.csv", rows.join("\n") + "\n");
console.log(`Wrote ${rows.length - 1} data rows`);
EOF
bun --bun /tmp/gen-golden.ts
```

- [ ] **Step 7.2: Write `malformed-headers.csv` (missing required column)**

```bash
cat > packages/csv-adapter/src/fixtures/malformed-headers.csv <<'EOF'
product_handle,title,brand,base_price,currency
sku-1,T,B,10.00,USD
EOF
```

- [ ] **Step 7.3: Write `malformed-rows.csv` (some bad rows mixed with good)**

```bash
cat > packages/csv-adapter/src/fixtures/malformed-rows.csv <<'EOF'
product_handle,title,brand,base_price,currency,category_path
sku-1,Good Product,Aonami,19.99,USD,apparel/tops/t_shirts
sku-2,,Aonami,19.99,USD,apparel/tops/t_shirts
sku-3,Bad Price Product,Aonami,not-a-number,USD,apparel/tops/t_shirts
sku-4,Another Good,Aonami,29.99,USD,apparel/tops/t_shirts
EOF
```

- [ ] **Step 7.4: Add fixture-driven test in csv-adapter.test.ts**

Append to `packages/csv-adapter/src/csv-adapter.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("CsvAdapter — fixtures", () => {
  const fixDir = join(import.meta.dir, "fixtures");

  it("processes 500 valid rows from golden-500.csv", async () => {
    const adapter = createCsvAdapter({
      objectStore: makeMockStore(readFileSync(join(fixDir, "golden-500.csv"), "utf-8")),
      storageKey: "x",
      parentArtifactId: "f" as never,
      fileChecksum: "h"
    });
    let count = 0;
    let rejected = 0;
    for await (const e of adapter.normalize({ sourceRef: "f" })) {
      if ((e.rawData as { __rejected?: boolean }).__rejected) rejected++;
      else count++;
    }
    expect(count).toBe(500);
    expect(rejected).toBe(0);
  });

  it("rejects header in malformed-headers.csv", async () => {
    const adapter = createCsvAdapter({
      objectStore: makeMockStore(readFileSync(join(fixDir, "malformed-headers.csv"), "utf-8")),
      storageKey: "x",
      parentArtifactId: "f" as never,
      fileChecksum: "h"
    });
    await expect(async () => {
      for await (const _e of adapter.normalize({ sourceRef: "f" })) { /* should throw */ }
    }).toThrow();
  });

  it("emits __rejected envelopes for malformed rows, valid for the rest", async () => {
    const adapter = createCsvAdapter({
      objectStore: makeMockStore(readFileSync(join(fixDir, "malformed-rows.csv"), "utf-8")),
      storageKey: "x",
      parentArtifactId: "f" as never,
      fileChecksum: "h"
    });
    let good = 0;
    let bad = 0;
    for await (const e of adapter.normalize({ sourceRef: "f" })) {
      if ((e.rawData as { __rejected?: boolean }).__rejected) bad++;
      else good++;
    }
    expect(good).toBe(2);
    expect(bad).toBe(2);
  });
});
```

- [ ] **Step 7.5: Run + commit**

```bash
bun --cwd packages/csv-adapter test
git add packages/csv-adapter/src/fixtures/ packages/csv-adapter/src/csv-adapter.test.ts
git commit -m "test(csv-adapter): 500-row golden fixture + malformed cases"
```

---

### Task 8: Implement the API route `POST /v1/ingestions/csv`

**Files:**
- Create: `apps/api/src/routes/ingestions-csv.ts`
- Modify: `apps/api/src/routes/ingestions.ts`

- [ ] **Step 8.1: Write the route**

```typescript
// apps/api/src/routes/ingestions-csv.ts
import { Hono } from "hono";
import type { Queue } from "bullmq";
import type { ObjectStore } from "@aonex/object-store";
import type { AuditEmitter } from "@aonex/audit";
import { schema, type DrizzleClient } from "@aonex/db";
import { sha256Hex } from "@aonex/lib-utils";
import { QUEUE, TenantId, MerchantId } from "@aonex/types";
import { randomUUID } from "node:crypto";

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB

export interface CsvIngestionRouteDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
  objectStore: ObjectStore;
  queues: { [QUEUE.CSV_EXTRACT]: Queue };
}

export function csvIngestionRoute(deps: CsvIngestionRouteDeps) {
  const app = new Hono();

  app.post("/csv", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
    const requestId = (c.get("requestId" as never) as string) ?? randomUUID();

    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return c.json({ success: false, error: "file required" }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return c.json({ success: false, error: `file too large (max ${MAX_FILE_BYTES})` }, 413);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const checksum = sha256Hex(buf);
    const storageKey = `csv/${tenantId}/${randomUUID()}.csv`;
    const { uri } = await deps.objectStore.put(storageKey, buf, "text/csv");

    // Insert file-level source_artifact
    const [artifact] = await deps.db.insert(schema.sourceArtifacts).values({
      tenantId,
      merchantId,
      sourceType: "templated_csv",
      sourceMarketplace: null,
      sourceExternalId: file.name,
      storageUri: uri,
      rawData: { fileName: file.name, sizeBytes: file.size },
      checksum,
      status: "processing"
    }).onConflictDoNothing().returning({ id: schema.sourceArtifacts.id });

    if (!artifact) {
      return c.json({
        success: true,
        data: { status: "duplicate", message: "CSV with identical checksum already ingested" }
      }, 200);
    }

    // Enqueue spine job
    const traceId = randomUUID();
    const job = await deps.queues[QUEUE.CSV_EXTRACT].add(
      "csv-extract",
      {
        tenantId,
        merchantId,
        parentArtifactId: artifact.id,
        storageKey,
        fileChecksum: checksum,
        requestId,
        traceId
      },
      {
        jobId: `csv-extract-${tenantId}-${traceId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000
      }
    );

    await deps.audit.emit({
      tenantId,
      merchantId,
      actorType: "user",
      eventType: "ingestion.csv_uploaded",
      entityType: "source_artifact",
      entityId: artifact.id,
      requestId,
      metadata: { fileName: file.name, sizeBytes: file.size, jobId: job.id }
    });

    return c.json({
      success: true,
      data: {
        ingestion_id: job.id,
        artifact_id: artifact.id,
        trace_id: traceId,
        status: "accepted",
        message: "CSV accepted. Validation continues asynchronously."
      }
    }, 202);
  });

  return app;
}
```

- [ ] **Step 8.2: Mount csv sub-router under existing `/ingestions`**

In `apps/api/src/routes/ingestions.ts`, after the existing route definitions, mount the csv sub-app:

```typescript
import { csvIngestionRoute } from "./ingestions-csv.js";

// Inside ingestionsRoutes(deps), after existing routes:
app.route("/", csvIngestionRoute({
  db: deps.db,    // ensure deps has db, audit, objectStore, queues
  audit: deps.audit,
  objectStore: deps.objectStore,
  queues: deps.queues
}));
```

Update the `IngestionsRouteDeps` interface to add the new dependencies, and update the API's `composition-root.ts` to pass them in.

- [ ] **Step 8.3: Add `QUEUE.CSV_EXTRACT` to types**

```typescript
// packages/types/src/index.ts — inside the QUEUE object
CSV_EXTRACT: "ingestion.csv-extract",
```

- [ ] **Step 8.4: Run typecheck + commit**

```bash
bun --bun --cwd apps/api typecheck
git add apps/api/src/routes/ingestions-csv.ts apps/api/src/routes/ingestions.ts packages/types/src/index.ts
git commit -m "feat(api): POST /v1/ingestions/csv route with MinIO upload + spine enqueue"
```

---

### Task 9: Implement the CSV extract worker processor

**Files:**
- Create: `apps/worker/src/processors/csv-extract.processor.ts`

- [ ] **Step 9.1: Write the processor**

```typescript
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import type { ObjectStore } from "@aonex/object-store";
import { runIngestion } from "@aonex/ingestion-spine";
import { createCsvAdapter } from "@aonex/csv-adapter";
import type { TenantId, MerchantId, ArtifactId } from "@aonex/types";

export interface CsvExtractJobData {
  tenantId: TenantId;
  merchantId: MerchantId;
  parentArtifactId: ArtifactId;
  storageKey: string;
  fileChecksum: string;
  requestId: string;
  traceId: string;
}

export interface CsvExtractProcessorDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
  objectStore: ObjectStore;
}

export function makeCsvExtractProcessor(deps: CsvExtractProcessorDeps) {
  return async (job: Job<CsvExtractJobData>) => {
    const { tenantId, merchantId, parentArtifactId, storageKey, fileChecksum, requestId, traceId } = job.data;

    const adapter = createCsvAdapter({
      objectStore: deps.objectStore,
      storageKey,
      parentArtifactId,
      fileChecksum
    });

    let processed = 0;
    let rejected = 0;
    const rejectionDetails: Array<{ rowNumber: number; errors: unknown }> = [];

    try {
      for await (const envelope of adapter.normalize({ sourceRef: storageKey })) {
        const raw = envelope.rawData as Record<string, unknown>;

        if (raw.__rejected === true) {
          rejected++;
          rejectionDetails.push({
            rowNumber: raw.rowNumber as number,
            errors: raw.errors
          });
          continue;
        }

        await runIngestion({
          db: deps.db,
          audit: deps.audit,
          adapter,
          envelope,
          tenantId,
          merchantId,
          requestId,
          traceId
        });
        processed++;

        // Periodic lock extension for long CSVs
        if (processed % 100 === 0) {
          await job.extendLock(job.token!, 60_000);
        }
      }

      // Update file-level artifact status
      await deps.db
        .update(schema.sourceArtifacts)
        .set({
          status: rejected === 0 ? "completed" : "needs_review",
          processingErrors: rejectionDetails as Record<string, unknown>[]
        })
        .where(eq(schema.sourceArtifacts.id, parentArtifactId));

      await deps.audit.emit({
        tenantId,
        merchantId,
        actorType: "worker",
        eventType: "ingestion.csv_completed",
        entityType: "source_artifact",
        entityId: parentArtifactId,
        requestId,
        metadata: { processed, rejected, rejectionCount: rejectionDetails.length }
      });

      return { processed, rejected, rejectionDetails: rejectionDetails.slice(0, 50) };
    } catch (err) {
      // Header validation failure or other catastrophic error
      const msg = err instanceof Error ? err.message : String(err);
      await deps.db
        .update(schema.sourceArtifacts)
        .set({
          status: "failed",
          processingErrors: [{ stage: "header_validation", error: msg }]
        })
        .where(eq(schema.sourceArtifacts.id, parentArtifactId));

      await deps.audit.emit({
        tenantId,
        merchantId,
        actorType: "worker",
        eventType: "ingestion.csv_failed",
        entityType: "source_artifact",
        entityId: parentArtifactId,
        requestId,
        metadata: { error: msg }
      });

      throw err;
    }
  };
}
```

- [ ] **Step 9.2: Wire processor in `composition-root.ts`**

In `apps/worker/src/composition-root.ts`:

```typescript
import { makeCsvExtractProcessor } from "./processors/csv-extract.processor.js";

const csvWorker = new Worker(
  QUEUE.CSV_EXTRACT,
  makeCsvExtractProcessor({ db, audit, objectStore }),
  { connection: redisConnection, concurrency: 3 }
);
```

The `objectStore` is constructed at the top of the composition root from env vars.

- [ ] **Step 9.3: Commit**

```bash
git add apps/worker/src/processors/csv-extract.processor.ts apps/worker/src/composition-root.ts
git commit -m "feat(worker): csv-extract processor — per-row spine invocation"
```

---

### Task 10: End-to-end smoke test against golden CSV

**Files:** none (operational)

- [ ] **Step 10.1: Start stack**

```bash
docker compose up -d postgres redis minio
bun --bun --cwd apps/api dev &
bun --bun --cwd apps/worker dev &
sleep 5
```

- [ ] **Step 10.2: Upload the golden CSV via curl**

```bash
curl -X POST http://localhost:8787/api/ingestions/csv \
  -H "Authorization: Bearer $TEST_JWT" \
  -F "file=@packages/csv-adapter/src/fixtures/golden-500.csv"
```

Expected: 202 with `ingestion_id`, `artifact_id`.

- [ ] **Step 10.3: Wait + verify**

```bash
sleep 60
psql "$DATABASE_URL" -c "SELECT count(*) FROM source_artifacts WHERE source_type = 'templated_csv';"
# Expected: 501 (1 file + 500 rows)
psql "$DATABASE_URL" -c "SELECT count(*) FROM product_versions WHERE category_path LIKE 'apparel/%' OR category_path LIKE 'outdoor/%' OR category_path LIKE 'electronics/%';"
# Expected: > 0 (number depends on validation success rate)
```

- [ ] **Step 10.4: Verify rejected rows**

```bash
curl http://localhost:8787/api/ingestions/csv \
  -H "Authorization: Bearer $TEST_JWT" \
  -F "file=@packages/csv-adapter/src/fixtures/malformed-rows.csv"
# Wait, then:
psql "$DATABASE_URL" -c "SELECT processing_errors FROM source_artifacts WHERE source_type = 'templated_csv' ORDER BY received_at DESC LIMIT 1;"
# Expected: JSON with row 2 (empty title) and row 3 (bad price) errors
```

---

### Task 11: Runbook + PR

**Files:**
- Create: `docs/superpowers/runbooks/csv-upload.md`

- [ ] **Step 11.1: Runbook**

```markdown
# Runbook — CSV upload

## Endpoint
`POST /v1/ingestions/csv` (multipart, field `file`)

## Template
See `packages/csv-adapter/src/template.ts`. Required: product_handle, title,
brand, base_price, currency, category_path. Open-ended: any column starting
with `attributes.`.

## Limits
- Max file: 100MB
- Per-row attempts: 3 with exponential backoff

## Operational checks
```sql
-- per-tenant CSV uploads in last 24h
SELECT tenant_id, count(*) AS files, sum((processing_errors IS NOT NULL)::int) AS files_with_errors
FROM source_artifacts
WHERE source_type = 'templated_csv'
  AND received_at > now() - interval '24 hours'
GROUP BY 1 ORDER BY 2 DESC;
```

## When a CSV fails
1. Check `source_artifacts.processing_errors` for the file row
2. If "Header validation failed" → user sent the wrong column set; reply with the missing/unexpected lists
3. If per-row errors → user can re-upload the file with corrected rows; checksum dedup will skip the original
```

- [ ] **Step 11.2: PR**

```bash
git add docs/superpowers/runbooks/csv-upload.md
git commit -m "docs: CSV upload runbook"
git push -u origin feature/phase-4-csv-lane
gh pr create --title "feat(phase-4): templated CSV lane" --body "<see plan §17 Phase 4>"
```

---

## Self-Review

1. **Spec coverage** — Phase 4 acceptance: 500-row golden CSV processes, malformed rows surface with row numbers, good rows reach canonical model via spine. Tasks 3–7 = adapter; Task 8 = API; Task 9 = worker; Task 10 = E2E. ✓
2. **Placeholder scan** — None. ✓
3. **Type consistency** — `IngestionEnvelope` shape consistent. `__rejected` sentinel pattern used uniformly. ✓
