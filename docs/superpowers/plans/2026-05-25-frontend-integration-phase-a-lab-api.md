# Lab HTTP API (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the staging-gate domain functions (`promoteStagedProduct` / `rejectStagedProduct` / `linkStagedProduct` + `staged_products` reads) as a JWT-protected, tenant-scoped `/api/lab/*` HTTP surface so the anomaly-lab frontend can drive it.

**Architecture:** Thin Hono routes (`apps/api`) over the existing `@aonex/catalog-service` domain functions — parse/validate input, read tenant context from JWT, call the domain fn, map results/errors to HTTP. No new domain logic. Mirrors the existing `review`/`catalog` route+handler pattern.

**Tech Stack:** TypeScript (strict), Hono, Drizzle, `@aonex/catalog-service`, `bun test`. Backend repo `aonex-backend`, branch `feat/anomaly-lab-staging-gate`.

**Spec:** `docs/superpowers/specs/2026-05-25-frontend-integration-catalog-anomaly-lab-design.md` §4.

---

## Conventions (read once before starting)

- **Route file pattern:** `apps/api/src/routes/ingestions.ts` / `review.ts` — `export function xRoutes(deps){ const app = new Hono(); app.get("/y", c => handler(c, deps)); return app; }`.
- **Handler pattern:** `apps/api/src/handlers/review.ts` — `export async function h(c: Context, deps: Deps): Promise<Response>`; tenant via `TenantId.unsafeFrom(c.get("tenantId" as never) as string)`; `merchantId` likewise; **reviewer id**: `const reviewerId = (c.get("userId" as never) as string | undefined) ?? merchantId;` (JWT sets no `userId` — fall back to merchantId, exactly as `review.ts` does); zod `safeParse(await c.req.json())` → `c.json({ success:false, error:... }, 400)`; params via `c.req.param("id")`.
- **Mounting:** in `apps/api/src/composition-root.ts`, the protected group (`protectedApp`, after `authMiddleware(jwt)`) mounts feature routes; add `protectedApp.route("/lab", anomalyLabRoutes({ db: db.client, audit }))` next to the `review` mount (~line 234). Final paths are `/api/lab/*`.
- **Response envelope (REQUIRED):** every endpoint returns `c.json({ data: <payload> }, status?)`. The frontend `request<T>` wrapper (`aonex-frontend/src/lib/api.ts`) returns `body.data` and **throws "Malformed response (missing data)" if `data` is absent** — so a bare `{items}` payload breaks the client. Error responses still use a status code (400/404/409) and a body like `{ error, message }` / `{ stillMissing }` (the client throws on non-2xx before unwrapping).
- **Domain fns** (exported from `@aonex/catalog-service`): `promoteStagedProduct({db,tenantId,stagedProductId,resolvedBy,fills,confirmedMatchProductId?}) → {productId}` (throws `StillIncompleteError` with `.stillMissing`, or `Error("...not pending")`); `rejectStagedProduct({db,tenantId,stagedProductId,resolvedBy}) → void` (throws if not pending); `linkStagedProduct({db,tenantId,stagedProductId,confirmedProductId,resolvedBy,fills}) → {productId}` (throws `"...not found"` / `"...not a live candidate"`). `StillIncompleteError` is exported.
- **Schema:** `schema.stagedProducts` (cols: stagedProductId, tenantId, status, denormTitle/Brand/Price/Currency, sourceKind, sourceArtifactId, gateVerdict jsonb `{missingFields, signals}`, matchCandidates jsonb `[{productId,score,kind}]`, observations jsonb, proposedIdentity jsonb, createdAt), `schema.catalogProducts` (for joining live-candidate title/brand), `schema.sourceArtifacts` (evidence).
- **Test pattern:** mirror `apps/api/src/handlers/admin-trace.test.ts` — build a `new Hono()`, add a middleware that `c.set("tenantId", ...)`/`c.set("merchantId", ...)`, mount the route, `app.fetch(new Request(...))`; real DB via `connectTestDb`/`createDb`; use a unique tenant + an `OTHER_TENANT_ID` for cross-tenant 404 checks; tenant-scoped cleanup.
- **Typecheck:** `bunx turbo run typecheck --filter=@aonex/api` (find the exact package name in `apps/api/package.json`; likely `@aonex/api`). Tests: `bun --cwd apps/api test <name>` if it has a `test` script, else `cd apps/api && bun test <name>`. Do NOT run lint (repo-wide broken). Pre-existing unrelated `@aonex/ingestion-variant-extractor` typecheck failure — ignore.

---

## File Structure

- Create: `apps/api/src/routes/anomaly-lab.ts` — route definitions + `AnomalyLabRouteDeps`.
- Create: `apps/api/src/handlers/anomaly-lab.ts` — the 7 handlers.
- Create: `apps/api/src/handlers/anomaly-lab.test.ts` — integration tests.
- Modify: `apps/api/src/composition-root.ts` — mount `/lab`.

---

## Task 1: Queue + stats read endpoints

**Files:** Create `routes/anomaly-lab.ts`, `handlers/anomaly-lab.ts`, `handlers/anomaly-lab.test.ts`; modify `composition-root.ts`.

- [ ] **Step 1: Write the failing test** (`handlers/anomaly-lab.test.ts`)

Mirror `admin-trace.test.ts` setup. Seed 2 pending `staged_products` for `TENANT` (unique uuid) + 1 for `OTHER_TENANT` + 1 non-pending (status='promoted') for `TENANT`. Assert `GET /api/lab/queue` returns only the 2 pending TENANT rows (not the promoted, not the other tenant), each with `stagedProductId`, `denormTitle`, `missingFields` (array), `candidateCount` (number). Assert `GET /api/lab/queue/stats` returns `{ total: 2, byReason, bySource, byAge }` with `total` = 2.

```typescript
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { createDb, schema, type DrizzleClient } from "@aonex/db";
import { eq } from "drizzle-orm";
import { anomalyLabRoutes } from "../routes/anomaly-lab.js";

const TENANT = "d1000000-0000-4000-8000-000000000001";
const OTHER = "d1000000-0000-4000-8000-0000000000ff";
let db: DrizzleClient;

function buildApp(tenantId = TENANT) {
  const root = new Hono();
  root.use("*", async (c, next) => {
    c.set("tenantId" as never, tenantId as never);
    c.set("merchantId" as never, tenantId as never);
    await next();
  });
  root.route("/api/lab", anomalyLabRoutes({ db, audit: { emit: async () => {} } as never }));
  return root;
}

async function insertStaged(tenantId: string, status: string, title: string, missing: string[]) {
  const [row] = await db.insert(schema.stagedProducts).values({
    tenantId, merchantId: tenantId,
    proposedIdentity: {}, observations: { observations: [], pricingObservations: [], inventoryObservations: [], identityHint: { targetIsVariant: false }, rawPayload: {} },
    denormTitle: title, sourceKind: "link",
    gateVerdict: { missingFields: missing, signals: [] }, matchCandidates: [], status
  } as never).returning({ id: schema.stagedProducts.stagedProductId });
  return row!.id;
}

beforeAll(async () => {
  db = createDb();
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT));
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, OTHER));
  await insertStaged(TENANT, "pending", "Pending One", ["brand"]);
  await insertStaged(TENANT, "pending", "Pending Two", ["identifier"]);
  await insertStaged(TENANT, "promoted", "Done", []);
  await insertStaged(OTHER, "pending", "Other Tenant", ["brand"]);
});
afterAll(async () => {
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, TENANT));
  await db.delete(schema.stagedProducts).where(eq(schema.stagedProducts.tenantId, OTHER));
});

test("GET /api/lab/queue returns only pending rows for the tenant", async () => {
  const res = await buildApp().fetch(new Request("http://x/api/lab/queue"));
  expect(res.status).toBe(200);
  const body = await res.json() as { items: Array<{ stagedProductId: string; denormTitle: string; missingFields: string[]; candidateCount: number }> };
  expect(body.items.length).toBe(2);
  expect(body.items.every((i) => typeof i.stagedProductId === "string")).toBe(true);
  expect(body.items.map((i) => i.denormTitle).sort()).toEqual(["Pending One", "Pending Two"]);
});

test("GET /api/lab/queue/stats returns total + breakdowns", async () => {
  const res = await buildApp().fetch(new Request("http://x/api/lab/queue/stats"));
  expect(res.status).toBe(200);
  const body = await res.json() as { total: number; byReason: Record<string, number>; bySource: Record<string, number> };
  expect(body.total).toBe(2);
  expect(body.bySource["link"]).toBe(2);
});
```

- [ ] **Step 2: Run, verify fail** — `cd apps/api && bun test anomaly-lab` → FAIL (module not found).

- [ ] **Step 3: Create `handlers/anomaly-lab.ts`** with `listQueue` + `queueStats`:

```typescript
// Anomaly Lab HTTP handlers — thin wrappers over @aonex/catalog-service staging fns.
import type { Context } from "hono";
import { and, asc, eq, gt } from "drizzle-orm";
import { schema } from "@aonex/db";
import { TenantId } from "@aonex/types";
import type { AnomalyLabRouteDeps } from "../routes/anomaly-lab.js";

const QUEUE_MAX = 100;

export async function listQueue(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, QUEUE_MAX);
  const cursor = c.req.query("cursor"); // ISO createdAt of the last item seen

  const conds = [eq(schema.stagedProducts.tenantId, tenantId), eq(schema.stagedProducts.status, "pending")];
  if (cursor) conds.push(gt(schema.stagedProducts.createdAt, new Date(cursor)));

  const rows = await deps.db
    .select({
      stagedProductId: schema.stagedProducts.stagedProductId,
      denormTitle: schema.stagedProducts.denormTitle,
      denormBrand: schema.stagedProducts.denormBrand,
      denormPrice: schema.stagedProducts.denormPrice,
      denormCurrency: schema.stagedProducts.denormCurrency,
      sourceKind: schema.stagedProducts.sourceKind,
      gateVerdict: schema.stagedProducts.gateVerdict,
      matchCandidates: schema.stagedProducts.matchCandidates,
      createdAt: schema.stagedProducts.createdAt
    })
    .from(schema.stagedProducts)
    .where(and(...conds))
    .orderBy(asc(schema.stagedProducts.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1]!.createdAt.toISOString() : null;

  const items = page.map((r) => {
    const verdict = (r.gateVerdict ?? {}) as { missingFields?: string[] };
    const candidates = (r.matchCandidates ?? []) as unknown[];
    return {
      stagedProductId: r.stagedProductId,
      denormTitle: r.denormTitle,
      denormBrand: r.denormBrand,
      denormPrice: r.denormPrice,
      denormCurrency: r.denormCurrency,
      sourceKind: r.sourceKind,
      missingFields: verdict.missingFields ?? [],
      candidateCount: candidates.length,
      createdAt: r.createdAt.toISOString()
    };
  });
  return c.json({ items, nextCursor });
}

export async function queueStats(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const rows = await deps.db
    .select({
      sourceKind: schema.stagedProducts.sourceKind,
      gateVerdict: schema.stagedProducts.gateVerdict,
      createdAt: schema.stagedProducts.createdAt
    })
    .from(schema.stagedProducts)
    .where(and(eq(schema.stagedProducts.tenantId, tenantId), eq(schema.stagedProducts.status, "pending")));

  const byReason: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byAge = { today: 0, week: 0, older: 0 };
  const now = Date.now();
  for (const r of rows) {
    bySource[r.sourceKind] = (bySource[r.sourceKind] ?? 0) + 1;
    for (const f of ((r.gateVerdict as { missingFields?: string[] })?.missingFields ?? [])) {
      byReason[f] = (byReason[f] ?? 0) + 1;
    }
    const ageDays = (now - r.createdAt.getTime()) / 86_400_000;
    if (ageDays < 1) byAge.today++;
    else if (ageDays < 7) byAge.week++;
    else byAge.older++;
  }
  return c.json({ total: rows.length, byReason, bySource, byAge });
}
```

- [ ] **Step 4: Create `routes/anomaly-lab.ts`** (queue + stats only for now):

```typescript
import { Hono } from "hono";
import type { AuditEmitter } from "@aonex/audit";
import type { DrizzleClient } from "@aonex/db";
import { listQueue, queueStats } from "../handlers/anomaly-lab.js";

export interface AnomalyLabRouteDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
}

export function anomalyLabRoutes(deps: AnomalyLabRouteDeps) {
  const app = new Hono();
  app.get("/queue", (c) => listQueue(c, deps));
  app.get("/queue/stats", (c) => queueStats(c, deps));
  return app;
}
```

- [ ] **Step 5: Wire into `composition-root.ts`** — add the import and mount next to the `review` route:

```typescript
import { anomalyLabRoutes } from "./routes/anomaly-lab.js";
// ...in the protectedApp block, after the /review mount:
protectedApp.route("/lab", anomalyLabRoutes({ db: db.client, audit }));
```

- [ ] **Step 6: Run, verify pass** — `cd apps/api && bun test anomaly-lab` → 2 pass. Typecheck: `bunx turbo run typecheck --filter=@aonex/api` → clean.

- [ ] **Step 7: Commit**
```bash
git add apps/api/src/routes/anomaly-lab.ts apps/api/src/handlers/anomaly-lab.ts apps/api/src/handlers/anomaly-lab.test.ts apps/api/src/composition-root.ts
git commit -m "feat(api): add /api/lab queue + stats read endpoints"
```

---

## Task 2: Staged detail + evidence read endpoints

**Files:** modify `handlers/anomaly-lab.ts`, `routes/anomaly-lab.ts`, `handlers/anomaly-lab.test.ts`.

- [ ] **Step 1: INVESTIGATE evidence storage** — read `packages/db/src/schema/source-artifacts.ts` (or wherever `sourceArtifacts` is defined) to find which column holds the raw payload/HTML (e.g. `rawData` jsonb). The evidence handler maps: link source → `{ kind: "html", content }` (pull the HTML string out of the artifact's rawData — confirm the field), connector source → `{ kind: "json", content }` (the raw payload object as JSON). Note what you find in your report.

- [ ] **Step 2: Write failing tests** — add to `anomaly-lab.test.ts`: seed a pending staged row with `matchCandidates: [{productId: <a live catalog product P you seed>, score: 0.6, kind: "live"}]` and a known `observations`/`missingFields`. Assert `GET /api/lab/staged/:id` (200) returns `{ stagedProductId, sourceKind, proposedIdentity, observations, missingFields, signals, matchCandidates }` where the live candidate entry is enriched with `title`/`brand` from the seeded catalog product P. Assert a cross-tenant fetch (`buildApp(OTHER).fetch(/staged/<TENANT's id>)`) returns **404**. Assert `GET /api/lab/staged/:id/evidence` returns `{ kind, content }`.

```typescript
test("GET /api/lab/staged/:id returns detail with live-candidate titles joined", async () => {
  // seed live product P + a staged row whose matchCandidates references P
  // ... (seed in the test; assert matchCandidates[0].title === P.title)
});
test("GET /api/lab/staged/:id is tenant-scoped (cross-tenant → 404)", async () => {
  const res = await buildApp(OTHER).fetch(new Request(`http://x/api/lab/staged/${tenantStagedId}`));
  expect(res.status).toBe(404);
});
```
(Write the full seeding/asserts following the Task 1 helpers + the admin-trace.test.ts catalog-product seeding pattern.)

- [ ] **Step 3: Implement `getStaged` + `getEvidence`** in `handlers/anomaly-lab.ts`:

```typescript
export async function getStaged(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const id = c.req.param("id")!;
  const [row] = await deps.db.select().from(schema.stagedProducts)
    .where(and(eq(schema.stagedProducts.stagedProductId, id), eq(schema.stagedProducts.tenantId, tenantId)));
  if (!row) return c.json({ error: "not_found" }, 404);

  const verdict = (row.gateVerdict ?? {}) as { missingFields?: string[]; signals?: unknown[] };
  const candidates = (row.matchCandidates ?? []) as Array<{ productId: string; score: number; kind: string }>;
  // Enrich LIVE candidates with title/brand from catalog_products.
  const liveIds = candidates.filter((x) => x.kind === "live").map((x) => x.productId);
  const liveInfo = liveIds.length
    ? await deps.db.select({ productId: schema.catalogProducts.productId, identity: schema.catalogProducts.identity, winningValues: schema.catalogProducts.winningValues })
        .from(schema.catalogProducts)
        .where(and(eq(schema.catalogProducts.tenantId, tenantId), inArray(schema.catalogProducts.productId, liveIds)))
    : [];
  const infoById = new Map(liveInfo.map((p) => [p.productId, p]));
  const enriched = candidates.map((cd) => {
    const info = infoById.get(cd.productId);
    const title = info ? ((info.winningValues as { title?: { _primary?: { value?: string } } } | null)?.title?._primary?.value ?? null) : null;
    const brand = info ? ((info.identity as { brand?: string } | null)?.brand ?? null) : null;
    return { ...cd, title, brand };
  });

  return c.json({
    stagedProductId: row.stagedProductId,
    sourceKind: row.sourceKind,
    sourceArtifactId: row.sourceArtifactId,
    proposedIdentity: row.proposedIdentity,
    observations: row.observations,
    missingFields: verdict.missingFields ?? [],
    signals: verdict.signals ?? [],
    matchCandidates: enriched
  });
}

export async function getEvidence(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const id = c.req.param("id")!;
  const [row] = await deps.db.select({ sourceArtifactId: schema.stagedProducts.sourceArtifactId, sourceKind: schema.stagedProducts.sourceKind })
    .from(schema.stagedProducts)
    .where(and(eq(schema.stagedProducts.stagedProductId, id), eq(schema.stagedProducts.tenantId, tenantId)));
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!row.sourceArtifactId) return c.json({ kind: "none", content: null });

  const [artifact] = await deps.db.select().from(schema.sourceArtifacts)
    .where(and(eq(schema.sourceArtifacts.id, row.sourceArtifactId), eq(schema.sourceArtifacts.tenantId, tenantId)));
  if (!artifact) return c.json({ kind: "none", content: null });

  // Map per source kind. CONFIRM the rawData field in Step 1 and adjust extraction.
  const raw = artifact.rawData as Record<string, unknown>;
  if (row.sourceKind === "link") {
    const html = (raw?.["html"] as string | undefined) ?? null;
    return c.json({ kind: "html", content: html });
  }
  return c.json({ kind: "json", content: raw });
}
```
(Add `inArray` to the drizzle-orm import. Adjust `winningValues.title._primary.value` to the actual winning-values shape if it differs — confirm against `catalog-products` reads in `handlers/catalog.ts`.)

- [ ] **Step 4: Add routes** in `routes/anomaly-lab.ts`:
```typescript
import { listQueue, queueStats, getStaged, getEvidence } from "../handlers/anomaly-lab.js";
// inside anomalyLabRoutes:
app.get("/staged/:id", (c) => getStaged(c, deps));
app.get("/staged/:id/evidence", (c) => getEvidence(c, deps));
```

- [ ] **Step 5: Run, verify pass** — `cd apps/api && bun test anomaly-lab` (all pass). Typecheck clean.

- [ ] **Step 6: Commit**
```bash
git add apps/api/src/routes/anomaly-lab.ts apps/api/src/handlers/anomaly-lab.ts apps/api/src/handlers/anomaly-lab.test.ts
git commit -m "feat(api): add /api/lab staged detail + evidence endpoints"
```

---

## Task 3: Action endpoints (approve / reject / link)

**Files:** modify `handlers/anomaly-lab.ts`, `routes/anomaly-lab.ts`, `handlers/anomaly-lab.test.ts`.

- [ ] **Step 1: Write failing tests** — seed a channel + an incomplete pending staged row (with pricing on that channel, missing brand+identifier) using the catalog-service staging fns OR a direct insert that mirrors what `stageProduct` writes. Assert:
  - `POST /api/lab/staged/:id/approve` with `{ fills: { brand:"Acme", gtin:"<13>" } }` → 200 `{ productId }`, and a `catalog_products` row now exists.
  - `POST .../approve` with incomplete fills (`{}`) on a fresh incomplete staged row → **400** with `{ stillMissing: [...] }`.
  - `POST .../reject` on a pending row → 200 `{ ok: true }`; the row is `status='rejected'`.
  - `POST .../link` with `{ confirmedProductId: <a non-candidate id> }` → **400**.
  - cross-tenant approve → **404** (or the domain "not pending" → check: a cross-tenant id won't be found pending for the caller's tenant → the domain throws → map to 404/409; assert it is NOT 200).

```typescript
test("POST /api/lab/staged/:id/approve with satisfying fills → 200 productId", async () => {
  // seed channel + incomplete staged row (pricing on channel, missing brand+identifier)
  const res = await buildApp().fetch(new Request(`http://x/api/lab/staged/${id}/approve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ fills: { brand: "Acme", gtin: "4000000000017" } })
  }));
  expect(res.status).toBe(200);
  const body = await res.json() as { productId: string };
  expect(typeof body.productId).toBe("string");
});

test("POST .../approve still-incomplete → 400 stillMissing", async () => {
  const res = await buildApp().fetch(new Request(`http://x/api/lab/staged/${id2}/approve`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fills: {} })
  }));
  expect(res.status).toBe(400);
  const body = await res.json() as { stillMissing: string[] };
  expect(body.stillMissing).toContain("identifier");
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement the action handlers** in `handlers/anomaly-lab.ts`:

```typescript
import { z } from "zod";
import { MerchantId } from "@aonex/types";
import { promoteStagedProduct, rejectStagedProduct, linkStagedProduct, StillIncompleteError } from "@aonex/catalog-service";

const FillsSchema = z.object({ fills: z.record(z.unknown()).default({}) });
const LinkSchema = z.object({ confirmedProductId: z.string().min(1), fills: z.record(z.unknown()).default({}) });

function reviewerId(c: Context): string {
  const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
  return (c.get("userId" as never) as string | undefined) ?? merchantId;
}

export async function approveStaged(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const id = c.req.param("id")!;
  const parsed = FillsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  try {
    const result = await promoteStagedProduct({ db: deps.db, tenantId, stagedProductId: id, resolvedBy: reviewerId(c), fills: parsed.data.fills });
    return c.json({ productId: result.productId });
  } catch (err) {
    if (err instanceof StillIncompleteError) return c.json({ stillMissing: err.stillMissing }, 400);
    return mapDomainError(c, err);
  }
}

export async function rejectStaged(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const id = c.req.param("id")!;
  try {
    await rejectStagedProduct({ db: deps.db, tenantId, stagedProductId: id, resolvedBy: reviewerId(c) });
    return c.json({ ok: true });
  } catch (err) { return mapDomainError(c, err); }
}

export async function linkStaged(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const id = c.req.param("id")!;
  const parsed = LinkSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.format() }, 400);
  try {
    const result = await linkStagedProduct({ db: deps.db, tenantId, stagedProductId: id, confirmedProductId: parsed.data.confirmedProductId, resolvedBy: reviewerId(c), fills: parsed.data.fills });
    return c.json({ productId: result.productId });
  } catch (err) { return mapDomainError(c, err); }
}

// Map domain Error messages to HTTP. "not pending" → 409; "not found" → 404;
// "not a live candidate" → 400; else 500.
function mapDomainError(c: Context, err: unknown): Response {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not pending/i.test(msg)) return c.json({ error: "conflict", message: msg }, 409);
  if (/not found/i.test(msg)) return c.json({ error: "not_found", message: msg }, 404);
  if (/not a live candidate/i.test(msg)) return c.json({ error: "bad_request", message: msg }, 400);
  return c.json({ error: "internal", message: msg }, 500);
}
```

- [ ] **Step 4: Add routes** in `routes/anomaly-lab.ts`:
```typescript
import { /* existing */ approveStaged, rejectStaged, linkStaged } from "../handlers/anomaly-lab.js";
app.post("/staged/:id/approve", (c) => approveStaged(c, deps));
app.post("/staged/:id/reject", (c) => rejectStaged(c, deps));
app.post("/staged/:id/link", (c) => linkStaged(c, deps));
```

- [ ] **Step 5: Run, verify pass** — `cd apps/api && bun test anomaly-lab` (all pass). Typecheck `bunx turbo run typecheck --filter=@aonex/api` clean. Also run the full apps/api suite to confirm no regression: `cd apps/api && bun test src` (ignore the unrelated flaky outbox-poller if present in worker — this is apps/api).

- [ ] **Step 6: Commit**
```bash
git add apps/api/src/routes/anomaly-lab.ts apps/api/src/handlers/anomaly-lab.ts apps/api/src/handlers/anomaly-lab.test.ts
git commit -m "feat(api): add /api/lab approve + reject + link action endpoints"
```

---

## Self-Review

**Spec coverage (§4):** queue ✓ (T1), queue/stats ✓ (T1), staged detail w/ candidate join ✓ (T2), evidence source-aware ✓ (T2), approve w/ 400 stillMissing + 409 ✓ (T3), reject ✓ (T3), link w/ 400 not-a-candidate ✓ (T3), tenant-scoping 404 ✓ (T2/T3), wiring ✓ (T1). All §4 endpoints covered.

**Placeholders:** Two explicit INVESTIGATE points (Task 2 Step 1: source_artifacts rawData field; the winning-values title path) — these are "confirm the exact field" instructions with a concrete default, not vague TODOs. The Task 2/T3 test bodies say "follow the Task 1 helpers + admin-trace seeding" for the repetitive seeding — the assertions and key calls are spelled out.

**Type consistency:** `AnomalyLabRouteDeps {db, audit}` defined in routes, imported by handlers. Handler names (`listQueue`, `queueStats`, `getStaged`, `getEvidence`, `approveStaged`, `rejectStaged`, `linkStaged`) consistent between route + handler files. Domain fn signatures match `@aonex/catalog-service` exports. `mapDomainError` shared by reject/link/approve.

---

## Execution note
After Phase A merges/lands, Phase B (lab frontend) consumes these exact endpoint shapes. Phase B + C get their own plans in `aonex-frontend`.
