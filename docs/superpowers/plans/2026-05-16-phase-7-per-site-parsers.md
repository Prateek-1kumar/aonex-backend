# Phase 7 — Per-Site Parsers (9 in Parallel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The 9 parser tasks are independent and can be dispatched to parallel subagents.

**Spec:** §6.7 + §17 Phase 7
**Depends on:** Phase 6 (extraction pack scaffolding — selector-health logging, ScrapingBee, browser fallback)

**Goal:** Ship per-site parsers for 9 tier-1 retailers in parallel. Each parser implements a shared `PerSiteParser` interface, owns its domain-specific selector ladder + JSON extraction logic, and ships with a 50-product canary set + selector-health alerts. Acceptance gate: at least 7 of 9 parsers promoted to production after 7-day shadow each; the 2 weakest stay in shadow with a Phase-7.1 follow-up.

**Architecture:** A new `@aonex/per-site-parsers` package houses a registry + interface; each parser is a sibling module. The `LinkAdapter` consults the registry when the URL's hostname matches a registered parser's domain list; the per-site parser runs FIRST (highest-priority Layer G), and its facts are merged into the generic Layer A/B output via the cross-validator. Per-parser canary URLs run hourly via a new `canary-poll` cron (registered in Phase 7, fires in Phase 8 dashboards).

**Tech Stack:** TypeScript, cheerio + node-html-parser (already used), Playwright (from Phase 6 — many tier-1 retailers require browser rendering).

**Acceptance:** 9 parsers exist in the registry. Each has a passing canary test against 50 hand-picked product URLs. Per-domain success rate ≥ 95% on the parser's canary set (post 7-day shadow). LLM-rescue rate < 30% on covered domains. 7 of 9 promoted to production; the 2 weakest documented + ticketed for Phase 7.1 rework.

---

## File Structure

**Files created**
- `packages/per-site-parsers/package.json` + `tsconfig.json` + `src/index.ts`
- `packages/per-site-parsers/src/types.ts` — `PerSiteParser` interface
- `packages/per-site-parsers/src/registry.ts` — domain → parser dispatch
- `packages/per-site-parsers/src/registry.test.ts`
- `packages/per-site-parsers/src/parsers/amazon.ts` + `.test.ts`
- `packages/per-site-parsers/src/parsers/ebay.ts` + `.test.ts`
- `packages/per-site-parsers/src/parsers/walmart.ts` + `.test.ts`
- `packages/per-site-parsers/src/parsers/decathlon.ts` + `.test.ts`
- `packages/per-site-parsers/src/parsers/bestbuy.ts` + `.test.ts`
- `packages/per-site-parsers/src/parsers/ikea.ts` + `.test.ts`
- `packages/per-site-parsers/src/parsers/aliexpress.ts` + `.test.ts`
- `packages/per-site-parsers/src/parsers/woocommerce-generic.ts` + `.test.ts`
- `packages/per-site-parsers/src/parsers/magento-generic.ts` + `.test.ts`
- `packages/per-site-parsers/src/fixtures/<retailer>/*.html` — recorded HTML snapshots for each parser's tests
- `packages/per-site-parsers/src/fixtures/<retailer>/canary-urls.json` — 50 URLs per parser
- `apps/worker/src/jobs/canary-poll.ts` + `.test.ts`

**Files modified**
- `packages/link-adapter/src/link-adapter.ts` — consult registry before generic extraction
- `apps/worker/src/jobs/index.ts` — register `canary-poll` cron

---

## Tasks

### Task 1: Branch + scaffold `@aonex/per-site-parsers`

- [ ] **Step 1.1: Branch + package skeleton**

```bash
git checkout main && git pull --ff-only
git checkout -b feature/phase-7-per-site-parsers
mkdir -p packages/per-site-parsers/src/{parsers,fixtures}
```

`packages/per-site-parsers/package.json`:

```json
{
  "name": "@aonex/per-site-parsers",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc -b", "typecheck": "tsc --noEmit", "test": "bun test", "lint": "eslint src/" },
  "dependencies": {
    "@aonex/ingestion-field-extractor": "workspace:*",
    "@aonex/ingestion-link-fetcher": "workspace:*",
    "@aonex/ingestion-browser-fallback": "workspace:*",
    "@aonex/selector-health": "workspace:*",
    "cheerio": "^1.0.0"
  }
}
```

`src/types.ts`:

```typescript
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export interface PerSiteParser {
  /** Hostname patterns this parser claims. Match by exact suffix. */
  domains: string[];
  /** Higher wins when multiple parsers match (rare). Default 100. */
  priority: number;
  /** Version string; used by selector-health monitoring. */
  fingerprint: string;
  /** Whether this parser requires a browser-rendered HTML payload. */
  requiresBrowser: boolean;
  /** Run the parser. Return empty array when nothing matched. */
  extract(input: { rawHtml: string; url: string }): Promise<ExtractedFact[]>;
}
```

`src/registry.ts`:

```typescript
import type { PerSiteParser } from "./types.js";

const parsers: PerSiteParser[] = [];

export function registerParser(p: PerSiteParser): void {
  parsers.push(p);
  parsers.sort((a, b) => b.priority - a.priority);
}

export function findParserForUrl(url: string): PerSiteParser | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  for (const p of parsers) {
    for (const dom of p.domains) {
      if (hostname === dom || hostname.endsWith(`.${dom}`)) return p;
    }
  }
  return null;
}

/** For tests only — reset registry */
export function _resetRegistry(): void {
  parsers.length = 0;
}
```

`src/index.ts`:

```typescript
export { type PerSiteParser } from "./types.js";
export { registerParser, findParserForUrl } from "./registry.js";

// Auto-register all parsers on import
import "./parsers/amazon.js";
import "./parsers/ebay.js";
import "./parsers/walmart.js";
import "./parsers/decathlon.js";
import "./parsers/bestbuy.js";
import "./parsers/ikea.js";
import "./parsers/aliexpress.js";
import "./parsers/woocommerce-generic.js";
import "./parsers/magento-generic.js";
```

- [ ] **Step 1.2: Registry test**

`src/registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { registerParser, findParserForUrl, _resetRegistry } from "./registry.js";

beforeEach(() => _resetRegistry());

describe("findParserForUrl", () => {
  it("returns null when no parser matches", () => {
    expect(findParserForUrl("https://example.com/x")).toBeNull();
  });

  it("matches exact hostname", () => {
    registerParser({ domains: ["amazon.com"], priority: 100, fingerprint: "v1", requiresBrowser: true, extract: async () => [] });
    expect(findParserForUrl("https://amazon.com/dp/B01")?.domains).toEqual(["amazon.com"]);
  });

  it("matches subdomain via suffix", () => {
    registerParser({ domains: ["amazon.com"], priority: 100, fingerprint: "v1", requiresBrowser: true, extract: async () => [] });
    expect(findParserForUrl("https://www.amazon.com/dp/B01")?.domains).toEqual(["amazon.com"]);
  });

  it("higher priority wins when multiple parsers match", () => {
    registerParser({ domains: ["amazon.com"], priority: 50, fingerprint: "low", requiresBrowser: true, extract: async () => [] });
    registerParser({ domains: ["amazon.com"], priority: 200, fingerprint: "high", requiresBrowser: true, extract: async () => [] });
    expect(findParserForUrl("https://amazon.com/dp/B01")?.fingerprint).toBe("high");
  });
});
```

- [ ] **Step 1.3: Install + commit**

```bash
bun install
bun --cwd packages/per-site-parsers test
git add packages/per-site-parsers/
git commit -m "feat(per-site-parsers): scaffold package + registry + interface"
```

---

### Task 2: Worked example — Amazon parser (template for the other 8)

The Amazon parser is the most-built, most-tested target. Use it as the worked example; the same pattern applies to the other 8 with minor variations.

**Files:**
- Create: `packages/per-site-parsers/src/parsers/amazon.ts`
- Create: `packages/per-site-parsers/src/parsers/amazon.test.ts`
- Create: `packages/per-site-parsers/src/fixtures/amazon/sample-product.html` (recorded HTML)
- Create: `packages/per-site-parsers/src/fixtures/amazon/canary-urls.json`

- [ ] **Step 2.1: Record a sample Amazon product page**

```bash
mkdir -p packages/per-site-parsers/src/fixtures/amazon
# In a real session: open the URL in a browser, View Source, save to this file.
# Example placeholder for the agent: use a curl-snapshot if Amazon allows it (often blocks).
curl -A "Mozilla/5.0" "https://www.amazon.com/dp/B0CHX3QJJB" -o packages/per-site-parsers/src/fixtures/amazon/sample-product.html
```

If Amazon blocks the curl, record the HTML manually via browser DevTools → Network → response.

- [ ] **Step 2.2: Write the failing test**

```typescript
// packages/per-site-parsers/src/parsers/amazon.test.ts
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { amazonParser } from "./amazon.js";

const html = readFileSync(join(import.meta.dir, "../fixtures/amazon/sample-product.html"), "utf-8");

describe("amazonParser", () => {
  it("declares amazon domains", () => {
    expect(amazonParser.domains).toEqual(
      expect.arrayContaining(["amazon.com", "amazon.co.uk", "amazon.de"])
    );
  });

  it("extracts title, brand, price, ASIN from a recorded product page", async () => {
    const facts = await amazonParser.extract({
      rawHtml: html,
      url: "https://www.amazon.com/dp/B0CHX3QJJB"
    });
    expect(facts.find((f) => f.rawKey === "title")?.extractedValue).toBeTruthy();
    expect(facts.find((f) => f.rawKey === "brand")?.extractedValue).toBeTruthy();
    expect(facts.find((f) => f.rawKey === "base_price")?.extractedValue).toBeTruthy();
    expect(facts.find((f) => f.rawKey === "asin")?.extractedValue).toBe("B0CHX3QJJB");
  });

  it("returns empty array when HTML is not an Amazon product page", async () => {
    const facts = await amazonParser.extract({ rawHtml: "<html></html>", url: "https://amazon.com/" });
    expect(facts).toEqual([]);
  });
});
```

- [ ] **Step 2.3: Implement the parser**

```typescript
// packages/per-site-parsers/src/parsers/amazon.ts
import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { PerSiteParser } from "../types.js";
import { registerParser } from "../registry.js";

function extractAsin(url: string): string | null {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/);
  return match ? match[1] : null;
}

export const amazonParser: PerSiteParser = {
  domains: ["amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.in", "amazon.co.jp", "amazon.ca", "amazon.com.au"],
  priority: 100,
  fingerprint: "amazon@1.0",
  requiresBrowser: true,    // Amazon SSRs most pages but anti-bot blocks static fetch frequently

  async extract({ rawHtml, url }): Promise<ExtractedFact[]> {
    const $ = cheerio.load(rawHtml);
    const facts: ExtractedFact[] = [];

    const asin = extractAsin(url);
    if (asin) {
      facts.push({
        rawKey: "asin",
        canonicalPath: null,
        extractedValue: asin,
        normalizedValue: null,
        unit: null,
        sourcePointer: "url:/dp/<asin>",
        extractionMethod: "amazon_parser",
        mappingMethod: null,
        mappingCandidates: null,
        sourceAlternatives: null,
        confidence: 1.0,
        approved: false
      });
    }

    // Title — #productTitle
    const title = $("#productTitle").text().trim();
    if (title) {
      facts.push(makeFact("title", title, "#productTitle", 0.95));
    }

    // Brand — #bylineInfo, plus fallback to data-bylineinfo
    const brand = $("#bylineInfo").text().trim().replace(/^Visit the | Store$/g, "").trim();
    if (brand) facts.push(makeFact("brand", brand, "#bylineInfo", 0.85));

    // Price — multiple candidates; Amazon shows the buy-box price prominently
    const priceText = $(".a-price .a-offscreen").first().text();
    const price = parseFloat(priceText.replace(/[^\d.]/g, ""));
    if (Number.isFinite(price)) facts.push(makeFact("base_price", price, ".a-price .a-offscreen", 0.92));

    // Currency — sometimes in the buy box too
    const currency = priceText.match(/(\$|€|£|₹|¥)/)?.[1];
    const currencyMap: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };
    if (currency && currencyMap[currency]) {
      facts.push(makeFact("currency", currencyMap[currency], "price_symbol", 0.85));
    }

    // Bullet points → description
    const bullets = $("#feature-bullets li span").map((_i, el) => $(el).text().trim()).get().filter((t) => t.length > 5);
    if (bullets.length > 0) {
      facts.push(makeFact("description", bullets.join("\n"), "#feature-bullets li span", 0.80));
    }

    // Images — #altImages li img
    const imageUrls = $("#altImages li img").map((_i, el) => $(el).attr("src")).get().filter((u): u is string => !!u);
    if (imageUrls.length > 0) {
      facts.push({
        rawKey: "images",
        canonicalPath: null,
        extractedValue: imageUrls.map((url) => ({ url })),
        normalizedValue: null,
        unit: null,
        sourcePointer: "#altImages li img",
        extractionMethod: "amazon_parser",
        mappingMethod: null,
        mappingCandidates: null,
        sourceAlternatives: null,
        confidence: 0.85,
        approved: false
      });
    }

    // Product details table → attributes
    $("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr").each((_i, el) => {
      const k = $(el).find("th, .a-text-bold").text().trim().replace(/\s+/g, "_").toLowerCase();
      const v = $(el).find("td, .a-list-item span:last-child").text().trim();
      if (k && v) facts.push(makeFact(k, v, `#productDetails ${k}`, 0.75));
    });

    return facts;
  }
};

function makeFact(rawKey: string, value: unknown, source: string, confidence: number): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue: value,
    normalizedValue: null,
    unit: null,
    sourcePointer: source,
    extractionMethod: "amazon_parser",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    confidence,
    approved: false
  };
}

registerParser(amazonParser);
```

- [ ] **Step 2.4: Create canary URL list**

`packages/per-site-parsers/src/fixtures/amazon/canary-urls.json`:

```json
{
  "domain": "amazon.com",
  "urls": [
    "https://www.amazon.com/dp/B0CHX3QJJB",
    "https://www.amazon.com/dp/B07XJ8C8F5",
    "..."
  ],
  "expectedFields": ["title", "brand", "base_price", "asin"]
}
```

Hand-curate 50 product URLs covering: electronics (10), apparel (10), home (10), toys (5), books (5), beauty (5), grocery (5). Verify each URL is a live product page (not "currently unavailable").

- [ ] **Step 2.5: Run + commit**

```bash
bun --cwd packages/per-site-parsers test
git add packages/per-site-parsers/src/parsers/amazon.ts packages/per-site-parsers/src/parsers/amazon.test.ts packages/per-site-parsers/src/fixtures/amazon/
git commit -m "feat(per-site-parsers): Amazon parser (50-URL canary set)"
```

---

### Task 3: Implement the remaining 8 parsers (parallel tasks)

Each follows the **exact same template** as Amazon: declare domains, record sample HTML, write test against fixture, implement parser, curate 50-URL canary list, register. Per-retailer quirks below; everything else mirrors Task 2.

The 8 parsers can be implemented in parallel — they touch independent files. **If using subagent-driven-development, dispatch 8 subagents simultaneously, one per parser.**

#### Task 3.1: eBay parser
- **Domains:** `ebay.com`, `ebay.co.uk`, `ebay.de`, `ebay.com.au`
- **Selector quirks:** Title in `h1.x-item-title__mainTitle`; price in `.x-price-primary span[itemprop="price"]`; item specifics in `.ux-labels-values__values-content`; variant matrix in embedded JS `viItem.rawSummary`.
- **Browser required:** Sometimes (eBay SSRs most fields)
- **File:** `parsers/ebay.ts` + `.test.ts` + `fixtures/ebay/`

#### Task 3.2: Walmart parser
- **Domains:** `walmart.com`
- **Selector quirks:** Title in `h1[itemprop="name"]`; price in `[data-automation-id="product-price"]`; specs in `[data-testid="product-specifications"]` table; variants in `[data-tl-id="ProductVariantsSelector"]`. Embedded `__NEXT_DATA__` carries the canonical product JSON — use that first.
- **Browser required:** Yes (Walmart aggressively blocks static)
- **File:** `parsers/walmart.ts` + `.test.ts` + `fixtures/walmart/`

#### Task 3.3: Decathlon parser
- **Domains:** `decathlon.com`, `decathlon.co.uk`, `decathlon.fr`, `decathlon.de`, `decathlon.in`
- **Selector quirks:** Title in `h1[data-testid="pdp-product-title"]`; price in `.product-price__value`; tech specs in `.product-features__list`; sport-specific attrs (capacity, season, waterproof rating) in `.product-features__item`. Strong JSON-LD support — generic JSON-LD parser handles a lot; per-site parser fills DOM-only specs.
- **Browser required:** No (mostly SSR)
- **File:** `parsers/decathlon.ts` + `.test.ts` + `fixtures/decathlon/`

#### Task 3.4: Best Buy parser
- **Domains:** `bestbuy.com`, `bestbuy.ca`
- **Selector quirks:** Title in `.heading-5.v-fw-regular`; price in `.priceView-customer-price span[aria-hidden="true"]`; specs in `.specs-table tbody tr`. SKU in URL `/site/<...>/[0-9]+\.p`.
- **Browser required:** Yes
- **File:** `parsers/bestbuy.ts` + `.test.ts` + `fixtures/bestbuy/`

#### Task 3.5: IKEA parser
- **Domains:** `ikea.com`
- **Selector quirks:** Title in `.pip-header-section__title--big`; price in `.pip-price__integer + .pip-price__decimal`; dimensions in `.range-revamp-product-information-section`; material in product description blocks. URL pattern `/p/<slug>-<sku>/`.
- **Browser required:** No (SSR)
- **File:** `parsers/ikea.ts` + `.test.ts` + `fixtures/ikea/`

#### Task 3.6: AliExpress parser
- **Domains:** `aliexpress.com`, `aliexpress.us`
- **Selector quirks:** Title in `h1[data-pl="product-title"]`; price in `.product-price-current`; specs in `.product-specs li`. AliExpress is JS-heavy; the embedded `window.runParams.data` JSON object carries the canonical product structure — extract that first.
- **Browser required:** Yes
- **File:** `parsers/aliexpress.ts` + `.test.ts` + `fixtures/aliexpress/`

#### Task 3.7: WooCommerce generic parser
- **Domains:** Empty array → registered for SIGNAL-based dispatch instead of hostname. Detect by `body.woocommerce` class + `wc-product-data` script presence. Modify `findParserForUrl` to also accept a signal-based dispatch path, OR keep this parser separate and call it from `LinkAdapter` when generic Layer A detects WooCommerce signals.
- **Selector quirks:** Title `h1.product_title.entry-title`; price `p.price .woocommerce-Price-amount`; specs `.woocommerce-product-attributes-item__value`; variants in `form.variations_form` `data-product_variations` attribute.
- **Browser required:** No
- **File:** `parsers/woocommerce-generic.ts` + `.test.ts` + `fixtures/woocommerce-generic/`

#### Task 3.8: Magento generic parser
- **Same signal-based dispatch as WooCommerce.** Detect by `body.catalog-product-view` class + `x-magento-init` script presence.
- **Selector quirks:** Title `.page-title.product`; price `.price-final_price .price-wrapper .price`; specs `.product.attribute.value` paired with `.product.attribute.label`. Variants in `mage-init` JSON config.
- **Browser required:** No
- **File:** `parsers/magento-generic.ts` + `.test.ts` + `fixtures/magento-generic/`

For each parser:
1. Branch sub-task: record sample HTML, write failing test, implement parser, register, commit
2. Curate 50-URL canary list
3. Run `bun --cwd packages/per-site-parsers test` to verify

```bash
# After each parser:
git add packages/per-site-parsers/src/parsers/<retailer>.ts \
        packages/per-site-parsers/src/parsers/<retailer>.test.ts \
        packages/per-site-parsers/src/fixtures/<retailer>/
git commit -m "feat(per-site-parsers): <retailer> parser (50-URL canary)"
```

---

### Task 4: Wire registry consultation in `LinkAdapter`

**Files:**
- Modify: `packages/link-adapter/src/link-adapter.ts`

- [ ] **Step 4.1: Update `LinkAdapter.extract`**

In `link-adapter.ts`, before the generic Layer A/B extraction:

```typescript
import { findParserForUrl } from "@aonex/per-site-parsers";

async extract(envelope: IngestionEnvelope): Promise<ExtractedFactSet> {
  const fetchResult = this.fetchCache.get(envelope.sourceExternalId);
  if (!fetchResult) { /* re-fetch fallback as before */ }

  // Layer G — per-site parser (highest priority when present)
  const perSiteParser = findParserForUrl(fetchResult.finalUrl);
  let perSiteFacts: ExtractedFact[] = [];
  if (perSiteParser) {
    perSiteFacts = await perSiteParser.extract({
      rawHtml: fetchResult.rawHtml,
      url: fetchResult.finalUrl
    });
  }

  // Layers A + B (always run; cross-validator merges with per-site facts)
  const structured = await extractStructured({
    pageUrl: fetchResult.finalUrl,
    rawHtml: fetchResult.rawHtml,
    structuredBlocks: fetchResult.structuredBlocks
  });

  // Merge: per-site wins ties (higher priority); cross-validator handles disagreements
  const allFacts = mergeWithPerSitePriority(perSiteFacts, structured.structured.facts);

  // ... existing LLM gap-fill below
  return { ... };
}

function mergeWithPerSitePriority(perSite: ExtractedFact[], generic: ExtractedFact[]): ExtractedFact[] {
  const seen = new Set(perSite.map((f) => f.rawKey));
  return [...perSite, ...generic.filter((f) => !seen.has(f.rawKey))];
}
```

- [ ] **Step 4.2: Commit**

```bash
git add packages/link-adapter/src/link-adapter.ts
git commit -m "feat(link-adapter): consult per-site parser registry before generic extraction"
```

---

### Task 5: Implement `canary-poll` cron

**Files:**
- Create: `apps/worker/src/jobs/canary-poll.ts` + `.test.ts`

- [ ] **Step 5.1: Implementation**

```typescript
// apps/worker/src/jobs/canary-poll.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AuditEmitter } from "@aonex/audit";
import { fetchLink } from "@aonex/ingestion-link-fetcher";
import { findParserForUrl } from "@aonex/per-site-parsers";

const FIXTURES_DIR = "packages/per-site-parsers/src/fixtures";

export interface CanaryPollResult {
  domain: string;
  total: number;
  passed: number;
  failed: Array<{ url: string; reason: string }>;
}

export async function runCanaryPoll(deps: { audit: AuditEmitter }): Promise<CanaryPollResult[]> {
  if (!existsSync(FIXTURES_DIR)) return [];
  const results: CanaryPollResult[] = [];

  for (const retailer of readdirSync(FIXTURES_DIR)) {
    const canaryFile = join(FIXTURES_DIR, retailer, "canary-urls.json");
    if (!existsSync(canaryFile)) continue;
    const config = JSON.parse(readFileSync(canaryFile, "utf-8")) as {
      domain: string;
      urls: string[];
      expectedFields: string[];
    };

    const result: CanaryPollResult = { domain: config.domain, total: config.urls.length, passed: 0, failed: [] };

    // Sample only 5 URLs per cron run to keep cost manageable.
    const sample = config.urls.slice(0, 5);
    for (const url of sample) {
      try {
        const fetched = await fetchLink(url, { timeoutMs: 10_000 });
        const parser = findParserForUrl(fetched.finalUrl);
        if (!parser) {
          result.failed.push({ url, reason: "no_parser_matched" });
          continue;
        }
        const facts = await parser.extract({ rawHtml: fetched.rawHtml, url: fetched.finalUrl });
        const missing = config.expectedFields.filter((f) => !facts.find((x) => x.rawKey === f));
        if (missing.length === 0) result.passed++;
        else result.failed.push({ url, reason: `missing_fields:${missing.join(",")}` });
      } catch (err) {
        result.failed.push({ url, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // Emit per-domain canary metric
    await deps.audit.emit({
      actorType: "worker",
      eventType: "canary.poll_completed",
      entityType: "per_site_parser",
      entityId: retailer,
      metadata: {
        domain: result.domain,
        total: result.total,
        passed: result.passed,
        failedCount: result.failed.length,
        failedSample: result.failed.slice(0, 3)
      }
    } as never);

    results.push(result);
  }

  return results;
}
```

- [ ] **Step 5.2: Register cron**

In `apps/worker/src/jobs/index.ts`:

```typescript
import { runCanaryPoll } from "./canary-poll.js";
// Add to CRONS array:
{
  name: "canary-poll",
  cron: "0 * * * *",    // hourly
  handler: (deps: { audit: AuditEmitter }) => runCanaryPoll({ audit: deps.audit })
}
```

- [ ] **Step 5.3: Commit**

```bash
git add apps/worker/src/jobs/canary-poll.ts apps/worker/src/jobs/index.ts
git commit -m "feat(worker): hourly canary-poll cron — 5 URLs per retailer per hour"
```

---

### Task 6: Shadow each parser for 7 days

This task is **operational**, not code:

- [ ] **Step 6.1: After PR merge, monitor `canary.poll_completed` audit events**

```sql
SELECT
  metadata->>'domain' as domain,
  date_trunc('day', created_at) as day,
  sum((metadata->>'passed')::int) as passed,
  sum((metadata->>'failedCount')::int) as failed
FROM audit_events
WHERE event_type = 'canary.poll_completed'
  AND created_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1, 2;
```

- [ ] **Step 6.2: Promote parsers that hold ≥ 95% pass rate for 7 days**

For each qualifying retailer, no code change is needed (parsers are already registered). Just remove any `priority: 0` shadow flag if applied.

- [ ] **Step 6.3: File Phase-7.1 tickets for parsers that miss the bar**

The 2 weakest parsers stay in shadow with reduced priority and a follow-up plan to improve selectors / add Playwright support / handle edge cases.

---

### Task 7: PR

```bash
git push -u origin feature/phase-7-per-site-parsers
gh pr create --title "feat(phase-7): 9 tier-1 per-site parsers (Amazon, eBay, Walmart, Decathlon, BestBuy, IKEA, AliExpress, WooCommerce, Magento)" --body "<see plan §17 Phase 7>"
```

---

## Self-Review

1. **Spec coverage** — 9 parsers built, canary cron, registry-based dispatch. ✓
2. **Placeholder scan** — Task 3 references "same shape as Task 2" — acceptable since Task 2 is a complete worked example; the per-retailer quirks are specific enough to drive the implementation. ✓
3. **Type consistency** — `PerSiteParser` shape consistent across all 9. `ExtractedFact` shape consistent. ✓

---

## Phase boundary

Phase 7 ships the per-site parser surface. Phase 8 builds the quality + observability layer that monitors these parsers (selector-health alerts, drift detection, calibrators).
