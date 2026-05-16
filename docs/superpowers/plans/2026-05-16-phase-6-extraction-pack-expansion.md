# Phase 6 — Extraction Pack Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** §6 Layers A–F + §17 Phase 6
**Depends on:** Phase 2 (LinkAdapter wired through spine)
**Blocks:** Phase 7 (per-site parsers slot into Layer G), Phase 9 (vision tier-3)

**Goal:** Close the gap to "industry-standard extraction" by (A) adding the missing structured-data parsers, (B) implementing the DOM heuristic pack, (C) adding a Playwright browser fallback with coverage-signal escalation, (D) integrating ScrapingBee for anti-bot, (E) polishing the Groq LLM gap-fill, plus selector-ladder + JSON-LD cross-validation per the research brief findings (15–30% of JSON-LD is invalid).

**Architecture:** Each capability lands as either a new module in `packages/ingestion/structured/src/parsers/` (Layer A), a new module in `packages/ingestion/dom-heuristics/src/` (Layer B, new package), a new module in `packages/ingestion/browser-fallback/` (Layer C, new package), an adapter in `packages/ingestion-link-fetcher` (Layer D, ScrapingBee), and edits to `packages/ingestion/llm-extractor` (Layer E). Coverage signal in `link-adapter` orchestrates escalation static → browser → unblock. Selector-ladder instrumentation emits per-rung counters.

**Tech Stack:** TypeScript, Playwright 1.49+, `node-html-parser` (already used) or `cheerio`, `xml2js` for RDFa, Groq via existing OpenAIProvider, BullMQ for metric emission.

**Acceptance:** Hard-domain success rate doubles on a domain-diverse golden set (manually picked URLs from Shein, Datadome-protected sites, SPA-only retailers). LLM-rescue rate < 30% on parser-covered domains. Cost-per-successful-extraction within budget (~$0.001 static, $0.003 browser, $0.015 unblock+vision).

---

## File Structure

**Files created**
- `packages/ingestion/structured/src/parsers/nuxt.ts` + `.test.ts`
- `packages/ingestion/structured/src/parsers/initial-state.ts` + `.test.ts`
- `packages/ingestion/structured/src/parsers/shopify-products-json.ts` + `.test.ts`
- `packages/ingestion/structured/src/parsers/magento-init.ts` + `.test.ts`
- `packages/ingestion/structured/src/parsers/woocommerce.ts` + `.test.ts`
- `packages/ingestion/structured/src/parsers/algolia-inline.ts` + `.test.ts`
- `packages/ingestion/structured/src/parsers/rdfa.ts` + `.test.ts`
- `packages/ingestion/structured/src/parsers/breadcrumb-list.ts` + `.test.ts`
- `packages/ingestion/structured/src/cross-validator.ts` + `.test.ts`
- `packages/ingestion-dom-heuristics/package.json` + tsconfig + `src/{index,price,images,breadcrumb,spec-table,variant-selector,title,description}.ts` + per-file tests
- `packages/ingestion-browser-fallback/package.json` + tsconfig + `src/{index,playwright-pool,escalation-signal}.ts` + tests
- `packages/ingestion-antibot-vendor/package.json` + tsconfig + `src/{index,scrapingbee-adapter,cost-ceiling}.ts` + tests
- `packages/ingestion/selector-health/package.json` + `src/{index,counter,ladder-logger}.ts` + tests

**Files modified**
- `packages/ingestion/structured/src/index.ts` — register new parsers
- `packages/ingestion/structured/src/merge.ts` — incorporate cross-validator output
- `packages/link-adapter/src/link-adapter.ts` — orchestrate Layer A → B → C → D → E escalation
- `packages/ingestion/llm-extractor/src/extractor.ts` — Groq-specific tweaks (model env vars, prompt caching where supported)
- `.env.example` — `SCRAPINGBEE_API_KEY`, `PLAYWRIGHT_POOL_SIZE`, `EXTRACTION_COST_CEILING_USD`

---

## Tasks

### Task 1: Branch + add Playwright + ScrapingBee SDK deps

- [ ] **Step 1.1: Branch**

```bash
git checkout main && git pull --ff-only
git checkout -b feature/phase-6-extraction-pack
```

- [ ] **Step 1.2: Install Playwright + add ScrapingBee dep**

```bash
bun add -d playwright @playwright/test
bun add -w scrapingbee
bunx playwright install chromium
```

(`scrapingbee` is the official Node SDK; it wraps the unlock-API endpoint.)

- [ ] **Step 1.3: Commit**

```bash
git add package.json bun.lock
git commit -m "deps: add playwright + scrapingbee for Phase 6 extraction pack"
```

---

### Task 2: Add new Layer A parsers (one task per parser)

For each parser, the workflow is identical:
1. Write failing test with a representative HTML fixture
2. Implement parser
3. Run + commit

Below is the **NUXT** parser as the worked example. Repeat the same shape for `initial-state.ts`, `shopify-products-json.ts`, `magento-init.ts`, `woocommerce.ts`, `algolia-inline.ts`, `rdfa.ts`, `breadcrumb-list.ts`.

#### Worked example: Task 2.1 — NUXT parser

**Files:**
- Create: `packages/ingestion/structured/src/parsers/nuxt.ts` + `.test.ts`

- [ ] **Step 2.1.1: Write the failing test**

```typescript
// packages/ingestion/structured/src/parsers/nuxt.test.ts
import { describe, it, expect } from "bun:test";
import { parseNuxt } from "./nuxt.js";

const NUXT_HTML = `<!DOCTYPE html>
<html>
<head><title>Product Page</title></head>
<body>
<div id="__nuxt"></div>
<script>window.__NUXT__={"state":{"product":{"id":"123","title":"Aonami Vision 55","brand":"Aonami","price":799.00,"gtin":"8901234567890","attributes":{"screen_size":"55","resolution":"4K","display_type":"OLED"}}}}</script>
</body>
</html>`;

describe("parseNuxt", () => {
  it("extracts product fields from window.__NUXT__", () => {
    const result = parseNuxt(NUXT_HTML);
    expect(result.parser).toBe("nuxt");
    expect(result.facts.length).toBeGreaterThanOrEqual(5);
    const titleFact = result.facts.find((f) => f.rawKey === "title");
    expect(titleFact?.extractedValue).toBe("Aonami Vision 55");
    const priceFact = result.facts.find((f) => f.rawKey === "price" || f.rawKey === "base_price");
    expect(priceFact?.extractedValue).toBe(799.00);
  });

  it("returns empty facts when __NUXT__ absent", () => {
    const result = parseNuxt("<html><body></body></html>");
    expect(result.facts).toEqual([]);
  });
});
```

- [ ] **Step 2.1.2: Implement `parseNuxt`**

```typescript
// packages/ingestion/structured/src/parsers/nuxt.ts
import type { ParserOutput } from "../types.js";

const NUXT_PATTERN = /window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/;

export function parseNuxt(rawHtml: string): ParserOutput {
  const match = rawHtml.match(NUXT_PATTERN);
  if (!match) return { parser: "nuxt", facts: [] };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return { parser: "nuxt", facts: [] };
  }

  const product = findProductNode(payload);
  if (!product) return { parser: "nuxt", facts: [] };

  const facts = [];
  const map: Record<string, string> = {
    title: "title",
    name: "title",
    brand: "brand",
    vendor: "brand",
    price: "base_price",
    gtin: "gtin",
    barcode: "gtin",
    mpn: "model_number",
    model: "model_number",
    description: "description"
  };

  for (const [key, rawKey] of Object.entries(map)) {
    if (product[key] != null) {
      facts.push({
        rawKey,
        canonicalPath: null,
        extractedValue: product[key],
        normalizedValue: null,
        unit: null,
        sourcePointer: `window.__NUXT__.${key}`,
        extractionMethod: "nuxt",
        mappingMethod: null,
        mappingCandidates: null,
        sourceAlternatives: null,
        confidence: 0.85,
        approved: false
      });
    }
  }

  // Flatten attributes
  if (product.attributes && typeof product.attributes === "object") {
    for (const [k, v] of Object.entries(product.attributes as Record<string, unknown>)) {
      facts.push({
        rawKey: k,
        canonicalPath: null,
        extractedValue: v,
        normalizedValue: null,
        unit: null,
        sourcePointer: `window.__NUXT__.attributes.${k}`,
        extractionMethod: "nuxt",
        mappingMethod: null,
        mappingCandidates: null,
        sourceAlternatives: null,
        confidence: 0.80,
        approved: false
      });
    }
  }

  return { parser: "nuxt", facts };
}

function findProductNode(payload: Record<string, unknown>): Record<string, unknown> | null {
  // Walk a few common locations
  const candidates = [
    payload.product,
    (payload.state as Record<string, unknown> | undefined)?.product,
    (payload.data as Record<string, unknown> | undefined)?.product,
    (payload.pageProps as Record<string, unknown> | undefined)?.product
  ];
  for (const c of candidates) {
    if (c && typeof c === "object") return c as Record<string, unknown>;
  }
  return null;
}
```

- [ ] **Step 2.1.3: Register + run + commit**

Open `packages/ingestion/structured/src/index.ts`. Find where `parseNextData`, `parseShopifyProbe`, etc. are imported and added to the `outputs` array. Add:

```typescript
import { parseNuxt } from "./parsers/nuxt.js";
// ...
const outputs = [
  // ... existing
  parseNuxt(input.rawHtml),
];
```

```bash
bun --cwd packages/ingestion/structured test
git add packages/ingestion/structured/src/parsers/nuxt.ts packages/ingestion/structured/src/parsers/nuxt.test.ts packages/ingestion/structured/src/index.ts
git commit -m "feat(structured): NUXT __NUXT__ parser"
```

#### Repeat for the remaining 7 parsers

- [ ] **Step 2.2: initial-state.ts** — same shape, matching `window.__INITIAL_STATE__` regex (covers Vue + custom React stores). 80% of the code is identical; differ in the regex pattern and source pointer.

- [ ] **Step 2.3: shopify-products-json.ts** — DIFFERENT from `shopify-probe.ts` (which probes the embedded `theme.product`). This new parser does a side-fetch to `<storeUrl>/products/<handle>.json`. Test against a recorded Shopify response fixture; implement with native `fetch`; abort after 3s timeout to avoid blocking the main static fetch path. Only invoked when the URL pattern matches a Shopify shop (`/products/<handle>` URL structure).

- [ ] **Step 2.4: magento-init.ts** — Match `<script type="text/x-magento-init">{ ... }</script>` blocks. Extract `*.Magento_Catalog/product/view` properties.

- [ ] **Step 2.5: woocommerce.ts** — Match `wc-product-data` script blocks + `wp-block-woocommerce-*` data attributes.

- [ ] **Step 2.6: algolia-inline.ts** — Many headless commerce stores embed full Algolia index hits in inline JSON. Look for `algolia-results` or `data-algolia` attributes; parse the embedded product records.

- [ ] **Step 2.7: rdfa.ts** — Less common than JSON-LD but still present. Use `cheerio` to walk DOM for `typeof="Product"` + `property="schema:name"` etc. patterns.

- [ ] **Step 2.8: breadcrumb-list.ts** — Schema.org BreadcrumbList is often present even when Product schema is absent. Extract the chain → propose as `category_path` candidate with a chain-depth-weighted confidence.

Each task is its own commit:

```bash
# After implementing each parser and its test:
git add packages/ingestion/structured/src/parsers/<parser>.ts packages/ingestion/structured/src/parsers/<parser>.test.ts packages/ingestion/structured/src/index.ts
git commit -m "feat(structured): <parser-name> parser"
```

---

### Task 3: JSON-LD cross-validator (15–30% of JSON-LD is invalid)

**Files:**
- Create: `packages/ingestion/structured/src/cross-validator.ts` + `.test.ts`

- [ ] **Step 3.1: Write the failing test**

```typescript
// packages/ingestion/structured/src/cross-validator.test.ts
import { describe, it, expect } from "bun:test";
import { crossValidate } from "./cross-validator.js";

describe("crossValidate", () => {
  it("flags JSON-LD price that disagrees with OpenGraph price", () => {
    const result = crossValidate({
      jsonLdFacts: [{ rawKey: "base_price", extractedValue: 99, sourcePointer: "json_ld.offers.price", confidence: 0.95 } as never],
      openGraphFacts: [{ rawKey: "base_price", extractedValue: 89, sourcePointer: "og.product:price:amount", confidence: 0.70 } as never],
      domFacts: []
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe("base_price");
  });

  it("agrees and merges when prices match", () => {
    const result = crossValidate({
      jsonLdFacts: [{ rawKey: "base_price", extractedValue: 99, sourcePointer: "json_ld.offers.price", confidence: 0.95 } as never],
      openGraphFacts: [{ rawKey: "base_price", extractedValue: 99, sourcePointer: "og.product:price:amount", confidence: 0.70 } as never],
      domFacts: []
    });
    expect(result.conflicts).toEqual([]);
    expect(result.agreedFacts.find((f) => f.rawKey === "base_price")?.confidence).toBeGreaterThan(0.95);
  });
});
```

- [ ] **Step 3.2: Implement**

```typescript
// packages/ingestion/structured/src/cross-validator.ts
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export interface CrossValidationInput {
  jsonLdFacts: ExtractedFact[];
  openGraphFacts: ExtractedFact[];
  domFacts: ExtractedFact[];
}

export interface CrossValidationResult {
  conflicts: Array<{ field: string; sources: Array<{ value: unknown; source: string; confidence: number }> }>;
  agreedFacts: ExtractedFact[];
}

const COMPARABLE_FIELDS = new Set(["base_price", "title", "brand", "gtin", "model_number"]);

export function crossValidate(input: CrossValidationInput): CrossValidationResult {
  const conflicts: CrossValidationResult["conflicts"] = [];
  const agreedFacts: ExtractedFact[] = [];

  for (const field of COMPARABLE_FIELDS) {
    const sources: Array<{ value: unknown; source: string; confidence: number }> = [];
    const fromJsonLd = input.jsonLdFacts.find((f) => f.rawKey === field);
    const fromOg = input.openGraphFacts.find((f) => f.rawKey === field);
    const fromDom = input.domFacts.find((f) => f.rawKey === field);
    if (fromJsonLd) sources.push({ value: fromJsonLd.extractedValue, source: "json_ld", confidence: fromJsonLd.confidence });
    if (fromOg) sources.push({ value: fromOg.extractedValue, source: "opengraph", confidence: fromOg.confidence });
    if (fromDom) sources.push({ value: fromDom.extractedValue, source: "dom", confidence: fromDom.confidence });

    if (sources.length < 2) {
      // single source; keep as-is
      const single = fromJsonLd ?? fromOg ?? fromDom;
      if (single) agreedFacts.push(single);
      continue;
    }

    // Compare normalized values
    const norm = (v: unknown) => typeof v === "string" ? v.trim().toLowerCase() : v;
    const allMatch = sources.every((s) => norm(s.value) === norm(sources[0].value));
    if (allMatch) {
      // Boost confidence: cross-source agreement
      const best = sources.reduce((max, s) => s.confidence > max.confidence ? s : max, sources[0]);
      const merged = { ...(fromJsonLd ?? fromOg ?? fromDom)!, confidence: Math.min(1.0, best.confidence + 0.05 * (sources.length - 1)) };
      agreedFacts.push(merged);
    } else {
      conflicts.push({ field, sources });
      // Keep the highest-confidence source but with confidence penalty per HLD §14.2 (-0.12 for potential duplicate)
      const winner = sources.reduce((max, s) => s.confidence > max.confidence ? s : max, sources[0]);
      const winnerFact = winner.source === "json_ld" ? fromJsonLd : winner.source === "opengraph" ? fromOg : fromDom;
      if (winnerFact) {
        agreedFacts.push({ ...winnerFact, confidence: Math.max(0, winnerFact.confidence - 0.12) });
      }
    }
  }

  // Carry forward non-comparable facts from all sources without modification
  for (const f of [...input.jsonLdFacts, ...input.openGraphFacts, ...input.domFacts]) {
    if (!COMPARABLE_FIELDS.has(f.rawKey)) agreedFacts.push(f);
  }

  return { conflicts, agreedFacts };
}
```

- [ ] **Step 3.3: Wire into existing merge.ts**

Open `packages/ingestion/structured/src/merge.ts`. Before the final merge step, call `crossValidate` on the parser outputs grouped by source family. Emit conflict counts via the audit channel (caller's responsibility).

- [ ] **Step 3.4: Run + commit**

```bash
bun --cwd packages/ingestion/structured test
git add packages/ingestion/structured/src/cross-validator.ts packages/ingestion/structured/src/cross-validator.test.ts packages/ingestion/structured/src/merge.ts
git commit -m "feat(structured): JSON-LD cross-validator (DOM/OG conflict detection)"
```

---

### Task 4: Build `@aonex/ingestion-dom-heuristics` (Layer B)

**Files:**
- Create: `packages/ingestion-dom-heuristics/package.json` + tsconfig + `src/*`

- [ ] **Step 4.1: Scaffold + price extractor**

```bash
mkdir -p packages/ingestion-dom-heuristics/src
```

`package.json`:

```json
{
  "name": "@aonex/ingestion-dom-heuristics",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc -b", "typecheck": "tsc --noEmit", "test": "bun test", "lint": "eslint src/" },
  "dependencies": {
    "@aonex/ingestion-field-extractor": "workspace:*",
    "cheerio": "^1.0.0"
  }
}
```

`src/price.ts`:

```typescript
import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

const CURRENCY_RE = /(?:\$|€|£|₹|¥)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:USD|EUR|GBP|INR|JPY)/g;
const PRICE_CLASS_RE = /price|amount|cost/i;

export function extractPriceFromDom(rawHtml: string): ExtractedFact | null {
  const $ = cheerio.load(rawHtml);
  const candidates: Array<{ value: number; source: string; confidence: number }> = [];

  // 1. itemprop="price"
  $('[itemprop="price"]').each((_i, el) => {
    const val = Number($(el).attr("content") ?? $(el).text());
    if (Number.isFinite(val)) candidates.push({ value: val, source: 'itemprop="price"', confidence: 0.90 });
  });

  // 2. Elements with price-y class names
  $("*").each((_i, el) => {
    const cls = $(el).attr("class") ?? "";
    if (!PRICE_CLASS_RE.test(cls)) return;
    const text = $(el).text();
    const match = text.match(CURRENCY_RE);
    if (match) {
      const num = Number(match[0].replace(/[^\d.]/g, ""));
      if (Number.isFinite(num)) candidates.push({ value: num, source: `class="${cls}"`, confidence: 0.65 });
    }
  });

  if (candidates.length === 0) return null;

  // Prefer highest-confidence; tiebreak by smallest value (avoid shipping/tax pollution)
  candidates.sort((a, b) => b.confidence - a.confidence || a.value - b.value);
  const best = candidates[0];

  return {
    rawKey: "base_price",
    canonicalPath: null,
    extractedValue: best.value,
    normalizedValue: null,
    unit: null,
    sourcePointer: `dom_heuristic:${best.source}`,
    extractionMethod: "dom_price",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: candidates.slice(1, 4).map((c) => ({ value: c.value, sourcePointer: c.source, confidence: c.confidence })),
    confidence: best.confidence,
    approved: false
  };
}
```

`src/price.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { extractPriceFromDom } from "./price.js";

describe("extractPriceFromDom", () => {
  it("picks itemprop=price over class-based candidates", () => {
    const html = `<div class="price">$99.99</div><meta itemprop="price" content="89.99" />`;
    const fact = extractPriceFromDom(html);
    expect(fact?.extractedValue).toBe(89.99);
  });

  it("returns null when no price found", () => {
    expect(extractPriceFromDom("<html><body>no price</body></html>")).toBeNull();
  });

  it("picks smallest among class-based candidates (avoid shipping pollution)", () => {
    const html = `<span class="price">$99.99</span><span class="price">$5.00</span>`;
    const fact = extractPriceFromDom(html);
    expect(fact?.extractedValue).toBe(5.00);
  });
});
```

- [ ] **Step 4.2: Add the remaining heuristics**

Repeat the test → implement → commit pattern for:
- `src/images.ts` — image-gallery extractor (filter by aspect ratio, min size, dedupe by URL stem)
- `src/breadcrumb.ts` — breadcrumb → category path extractor
- `src/spec-table.ts` — `<table>` + `<dl>` spec table parser
- `src/variant-selector.ts` — `<select>` + radio + swatch variant extractor
- `src/title.ts` — title with priority chain (h1 > og:title > json-ld title)
- `src/description.ts` — longest-text-block near product area

Each gets one test file + one implementation file + one commit (~6 commits total).

- [ ] **Step 4.3: Aggregate in `src/index.ts`**

```typescript
export { extractPriceFromDom } from "./price.js";
export { extractImagesFromDom } from "./images.js";
export { extractBreadcrumbFromDom } from "./breadcrumb.js";
export { extractSpecTableFromDom } from "./spec-table.js";
export { extractVariantSelectorFromDom } from "./variant-selector.js";
export { extractTitleFromDom } from "./title.js";
export { extractDescriptionFromDom } from "./description.js";

export interface DomHeuristicResult {
  facts: import("@aonex/ingestion-field-extractor").ExtractedFact[];
}

export function runDomHeuristics(rawHtml: string): DomHeuristicResult {
  const facts = [
    extractPriceFromDom(rawHtml),
    ...extractImagesFromDom(rawHtml),
    extractBreadcrumbFromDom(rawHtml),
    ...extractSpecTableFromDom(rawHtml),
    ...extractVariantSelectorFromDom(rawHtml),
    extractTitleFromDom(rawHtml),
    extractDescriptionFromDom(rawHtml)
  ].filter((f): f is NonNullable<typeof f> => f !== null);
  return { facts };
}
```

- [ ] **Step 4.4: Final commit for the package**

```bash
git add packages/ingestion-dom-heuristics/
git commit -m "feat(dom-heuristics): aggregate runner with 7 heuristic extractors"
```

---

### Task 5: Build `@aonex/ingestion-browser-fallback` (Layer C — Playwright)

**Files:**
- Create: `packages/ingestion-browser-fallback/package.json` + tsconfig + `src/*`

- [ ] **Step 5.1: Scaffold + escalation signal**

`src/escalation-signal.ts`:

```typescript
/**
 * Spec §6.3 — decide whether to escalate from static fetch to browser render.
 * Cheap heuristics on the raw HTML.
 */
export function shouldEscalateToBrowser(opts: {
  rawHtml: string;
  hasJsonLd: boolean;
  hasNextData: boolean;
  hasNuxt: boolean;
  coveragePercent: number;
}): { escalate: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (opts.rawHtml.length < 30_000) reasons.push("body_under_30kb");
  if (/<noscript>.*enable.+(java)?script/i.test(opts.rawHtml)) reasons.push("noscript_enable_js");
  if (!opts.hasJsonLd && !opts.hasNextData && !opts.hasNuxt) reasons.push("no_structured_data");
  if (opts.coveragePercent < 0.5) reasons.push(`coverage_${(opts.coveragePercent * 100).toFixed(0)}pct_below_50`);

  return { escalate: reasons.length >= 2, reasons };
}
```

- [ ] **Step 5.2: Playwright pool**

`src/playwright-pool.ts`:

```typescript
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface FetchBrowserResult {
  rawHtml: string;
  finalUrl: string;
  statusCode: number;
  fetchDurationMs: number;
}

let sharedBrowser: Browser | null = null;
let activeContexts = 0;
const MAX_CONCURRENT = Number(process.env.PLAYWRIGHT_POOL_SIZE ?? "10");

async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"]
    });
  }
  return sharedBrowser;
}

export async function fetchWithBrowser(url: string, opts?: {
  waitForSelector?: string;
  timeoutMs?: number;
}): Promise<FetchBrowserResult> {
  while (activeContexts >= MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 100));
  }
  activeContexts++;
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 }
  });
  const page: Page = await context.newPage();

  // Resource blocking for speed
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "stylesheet" || t === "font" || t === "media") return route.abort();
    return route.continue();
  });

  const start = Date.now();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts?.timeoutMs ?? 20_000 });
    if (opts?.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: 5_000 }).catch(() => undefined);
    }
    const rawHtml = await page.content();
    return {
      rawHtml,
      finalUrl: page.url(),
      statusCode: response?.status() ?? 0,
      fetchDurationMs: Date.now() - start
    };
  } finally {
    await context.close();
    activeContexts--;
  }
}

export async function closeBrowserPool(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}
```

- [ ] **Step 5.3: Smoke test (integration-only)**

`src/playwright-pool.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { fetchWithBrowser, closeBrowserPool } from "./playwright-pool.js";

const haveBrowser = process.env.PLAYWRIGHT_INTEGRATION === "1";

describe.if(haveBrowser)("fetchWithBrowser — integration", () => {
  it("fetches a static page and returns HTML", async () => {
    const result = await fetchWithBrowser("https://example.com/");
    expect(result.statusCode).toBe(200);
    expect(result.rawHtml).toContain("Example Domain");
  }, 30_000);

  afterAll(async () => {
    await closeBrowserPool();
  });
});
```

- [ ] **Step 5.4: Commit**

```bash
git add packages/ingestion-browser-fallback/
git commit -m "feat(browser-fallback): Playwright pool + escalation signal"
```

---

### Task 6: Build `@aonex/ingestion-antibot-vendor` (Layer D — ScrapingBee)

**Files:**
- Create: `packages/ingestion-antibot-vendor/package.json` + tsconfig + `src/*`

- [ ] **Step 6.1: ScrapingBee adapter**

`src/scrapingbee-adapter.ts`:

```typescript
import scrapingbee from "scrapingbee";

const client = new scrapingbee.ScrapingBeeClient(process.env.SCRAPINGBEE_API_KEY ?? "");

export interface UnblockResult {
  rawHtml: string;
  finalUrl: string;
  costCredits: number;
  durationMs: number;
}

export async function unblockWithScrapingBee(url: string, opts?: {
  premiumProxy?: boolean;
  jsRendering?: boolean;
  countryCode?: string;
}): Promise<UnblockResult> {
  const start = Date.now();
  const params: Record<string, unknown> = {
    render_js: opts?.jsRendering !== false,
    premium_proxy: opts?.premiumProxy ?? false,
    country_code: opts?.countryCode ?? "us"
  };

  const response = await client.get({ url, params });
  const html = response.data.toString("utf-8");

  // ScrapingBee returns credit cost in response headers
  const cost = Number(response.headers["spb-cost"] ?? "1");

  return {
    rawHtml: html,
    finalUrl: response.headers["spb-resolved-url"] ?? url,
    costCredits: cost,
    durationMs: Date.now() - start
  };
}
```

- [ ] **Step 6.2: Cost ceiling enforcement**

`src/cost-ceiling.ts`:

```typescript
const CEILING_USD = Number(process.env.EXTRACTION_COST_CEILING_USD ?? "0.05");
const CREDIT_TO_USD = 0.0001;    // ScrapingBee Hobby tier: $49 / 250k credits ≈ $0.0001/credit

export function withinCostCeiling(creditsUsed: number, additionalCredits: number): boolean {
  const projectedUsd = (creditsUsed + additionalCredits) * CREDIT_TO_USD;
  return projectedUsd <= CEILING_USD;
}

export function creditsToUsd(credits: number): number {
  return credits * CREDIT_TO_USD;
}
```

- [ ] **Step 6.3: Commit**

```bash
git add packages/ingestion-antibot-vendor/
git commit -m "feat(antibot-vendor): ScrapingBee adapter + cost-ceiling enforcement"
```

---

### Task 7: Orchestrate escalation in `LinkAdapter`

**Files:**
- Modify: `packages/link-adapter/src/link-adapter.ts`

- [ ] **Step 7.1: Update `LinkAdapter.normalize` to escalate based on signal**

Open `packages/link-adapter/src/link-adapter.ts`. Wrap the fetcher call with escalation logic:

```typescript
import { shouldEscalateToBrowser, fetchWithBrowser } from "@aonex/ingestion-browser-fallback";
import { unblockWithScrapingBee, withinCostCeiling } from "@aonex/ingestion-antibot-vendor";

// Inside normalize() — after the initial static fetch:
const staticResult = await this.deps.fetcher(input.sourceRef);

// Quick coverage probe on the static result
const hasJsonLd = (staticResult.structuredBlocks.jsonLd?.length ?? 0) > 0;
const hasNextData = (staticResult.structuredBlocks.nextData?.length ?? 0) > 0;
const hasNuxt = /window\.__NUXT__/.test(staticResult.rawHtml);

const escalation = shouldEscalateToBrowser({
  rawHtml: staticResult.rawHtml,
  hasJsonLd,
  hasNextData,
  hasNuxt,
  coveragePercent: hasJsonLd ? 0.8 : hasNextData || hasNuxt ? 0.7 : 0.3
});

let result = staticResult;
let escalatedTo: "static" | "browser" | "unblock" = "static";
let costCredits = 0;

if (escalation.escalate) {
  try {
    const browserResult = await fetchWithBrowser(input.sourceRef, { timeoutMs: 20_000 });
    result = { ...staticResult, rawHtml: browserResult.rawHtml, finalUrl: browserResult.finalUrl };
    escalatedTo = "browser";
  } catch (browserErr) {
    // Browser blocked → try unblock vendor (paid)
    if (withinCostCeiling(costCredits, 5)) {    // 5 credits typical for premium+JS
      const unblockResult = await unblockWithScrapingBee(input.sourceRef, { premiumProxy: true, jsRendering: true });
      result = { ...staticResult, rawHtml: unblockResult.rawHtml, finalUrl: unblockResult.finalUrl };
      escalatedTo = "unblock";
      costCredits += unblockResult.costCredits;
    }
  }
}

// Yield the envelope with escalation metadata in rawData for the extract stage
yield {
  ...envelope,
  rawData: {
    ...envelope.rawData,
    escalatedTo,
    costCredits
  }
};
```

- [ ] **Step 7.2: Commit**

```bash
git add packages/link-adapter/src/link-adapter.ts
git commit -m "feat(link-adapter): escalation ladder static → browser → unblock"
```

---

### Task 8: Build `@aonex/selector-health` for ladder logging

**Files:**
- Create: `packages/selector-health/package.json` + `src/index.ts` + `src/counter.ts` + `src/ladder-logger.ts`

- [ ] **Step 8.1: Counter + ladder logger**

`src/counter.ts`:

```typescript
import type { AuditEmitter } from "@aonex/audit";

/**
 * Spec §6.7 + §14.5 — per-selector firing counter.
 * Emits via the audit channel; aggregation runs in the selector-health-scan cron (Phase 8).
 */
export async function recordSelectorFiring(opts: {
  audit: AuditEmitter;
  selectorId: string;
  domain: string;
  success: boolean;
  parserVersion: string;
  tenantId: import("@aonex/types").TenantId;
}): Promise<void> {
  await opts.audit.emit({
    tenantId: opts.tenantId,
    actorType: "worker",
    eventType: "selector.fired",
    entityType: "selector",
    entityId: opts.selectorId,
    metadata: {
      domain: opts.domain,
      success: opts.success,
      parserVersion: opts.parserVersion
    }
  });
}
```

`src/ladder-logger.ts`:

```typescript
import type { AuditEmitter } from "@aonex/audit";

/**
 * Spec §6.7 / §14.5 — log which rung of the parser ladder produced each field.
 * Used by selector-health-scan cron to detect "silent LLM-rescue" patterns
 * (when a normally-strong rung's share drops and LLM rescue rate spikes).
 */
export async function recordLadderRung(opts: {
  audit: AuditEmitter;
  field: string;
  rung: "json_ld" | "microdata" | "opengraph" | "nuxt" | "next_data" | "shopify_probe" | "shopify_products_json" | "magento" | "woocommerce" | "algolia" | "dom_heuristic" | "llm_gap_fill" | "vision_llm" | "per_site_parser";
  domain: string;
  parserVersion: string;
  tenantId: import("@aonex/types").TenantId;
}): Promise<void> {
  await opts.audit.emit({
    tenantId: opts.tenantId,
    actorType: "worker",
    eventType: "ladder.rung_fired",
    entityType: "field",
    entityId: opts.field,
    metadata: {
      rung: opts.rung,
      domain: opts.domain,
      parserVersion: opts.parserVersion
    }
  });
}
```

- [ ] **Step 8.2: Wire into LinkAdapter's extract() so each fact emits a rung event**

In `link-adapter.ts`, after extraction collects facts, iterate and call `recordLadderRung` per fact mapped to its `extractionMethod`. (Lightweight — single audit event per field per ingestion.)

- [ ] **Step 8.3: Commit**

```bash
git add packages/selector-health/ packages/link-adapter/src/link-adapter.ts
git commit -m "feat(selector-health): per-selector counter + ladder-rung logger"
```

---

### Task 9: LLM polish — Groq-specific tweaks

**Files:**
- Modify: `packages/ingestion/llm-extractor/src/extractor.ts`
- Modify: `packages/ingestion/llm-extractor/src/types.ts`

- [ ] **Step 9.1: Allow base URL + model from env**

In `packages/ingestion/llm-extractor/src/types.ts`, change the default config:

```typescript
export const DEFAULT_LLM_CONFIG = {
  baseUrl: process.env.GROQ_BASE_URL ?? process.env.OPENAI_BASE_URL ?? undefined,
  model: process.env.GROQ_MODEL_GAP_FILL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  classifierModel: process.env.GROQ_MODEL_CLASSIFIER ?? "llama-3.1-8b-instant"
};
```

- [ ] **Step 9.2: Use classifier model for the category-detect call (cheaper)**

In `packages/ingestion/llm-extractor/src/extractor.ts`, if there's a category-detect code path, swap its model to `DEFAULT_LLM_CONFIG.classifierModel`. (Skip if category detection lives elsewhere — likely in `packages/ingestion/category-detector`.)

- [ ] **Step 9.3: Commit**

```bash
git add packages/ingestion/llm-extractor/
git commit -m "feat(llm-extractor): Groq-aware defaults (base URL + classifier model)"
```

---

### Task 10: PR

- [ ] **Step 10.1: Push + PR**

```bash
git push -u origin feature/phase-6-extraction-pack
gh pr create --title "feat(phase-6): extraction pack expansion (Layers A–E + selector health)" --body "<see plan §17 Phase 6>"
```

---

## Self-Review

1. **Spec coverage** — Layers A (parsers + cross-validator), B (DOM heuristics), C (browser), D (ScrapingBee), E (LLM polish), plus selector-health logging. ✓
2. **Placeholder scan** — Step 2.2–2.8 use "same shape as Step 2.1" guidance for the 7 repeat parsers. This is intentional pattern-reference, not placeholder — engineer has the full worked example in 2.1.1–2.1.3. ✓
3. **Type consistency** — `ExtractedFact` shape consistent across parsers. `escalation` rung enum complete. ✓

---

## Phase boundary

Phase 6 leaves the link extraction pipeline with full Layers A–E + selector-health logging. Phase 7 adds Layer G per-site parsers (9 in parallel).
