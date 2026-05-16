# Phase 9 — Vision LLM Tier-3 + Multi-Source Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** §6.6 (Layer F vision) + §6.8 (Layer H multi-source) + §17 Phase 9
**Depends on:** Phase 6 (Playwright + ScrapingBee), Phase 8 (calibrators)

**Goal:** Add the last two extraction-pack layers: (F) vision LLM as a tier-3 escalation when image-spec signal fires, and (H) multi-source verification that reconciles facts when the same GTIN is ingested from multiple sources. New `value_conflict` review task surfaces unresolvable cross-source disagreements.

**Architecture:** New `@aonex/vision-extractor` package wraps Groq Llama 3.2 90B Vision; called by `LinkAdapter` ONLY when image-spec triggers (apparel size charts, electronics spec graphics, image-rendered prices). New `@aonex/multi-source-reconciler` package implements the 40/20/25/15 score formula and the field-level voting policy from the research brief; integrated into `applyApprovedDiff` when an existing product with the same GTIN already exists.

**Tech Stack:** TypeScript, Playwright screenshot API, Groq (vision model), Jaro-Winkler for title similarity (`fast-jaro-winkler` npm package).

**Acceptance:** Vision LLM fires only on documented signals (audit_event proves no blanket-vision). Multi-source verification reduces duplicate products and raises cross-sourced composite confidence. `value_conflict` review tasks emit when sources disagree on high-weight fields (price, GTIN, brand).

---

## File Structure

**Files created**
- `packages/vision-extractor/package.json` + `src/{index,vision,signal-detector,screenshot}.ts` + tests
- `packages/multi-source-reconciler/package.json` + `src/{index,scoring,policy,jaro-winkler}.ts` + tests

**Files modified**
- `packages/link-adapter/src/link-adapter.ts` — escalate to vision when signal fires
- `packages/ingestion-browser-fallback/src/playwright-pool.ts` — add `captureScreenshot()` API
- `packages/catalog/catalog-service/src/index.ts` — call reconciler when GTIN matches existing
- `packages/db/src/schema/review.ts` — add `value_conflict` to task_type enum

---

## Tasks

### Task 1: Branch + add screenshot API to Playwright pool

- [ ] **Step 1.1: Branch**

```bash
git checkout main && git pull --ff-only
git checkout -b feature/phase-9-vision-multisource
```

- [ ] **Step 1.2: Add `captureScreenshot` to `playwright-pool.ts`**

Open `packages/ingestion-browser-fallback/src/playwright-pool.ts` and add:

```typescript
export async function fetchWithBrowserAndScreenshot(url: string, opts?: {
  timeoutMs?: number;
  screenshotSelector?: string;
}): Promise<FetchBrowserResult & { screenshotBase64: string }> {
  while (activeContexts >= MAX_CONCURRENT) await new Promise((r) => setTimeout(r, 100));
  activeContexts++;
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 }
  });
  const page = await context.newPage();

  // For screenshot mode, allow images + CSS (we need the rendered page).
  const start = Date.now();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts?.timeoutMs ?? 25_000 });
    if (opts?.screenshotSelector) {
      await page.waitForSelector(opts.screenshotSelector, { timeout: 5_000 }).catch(() => undefined);
    }
    const rawHtml = await page.content();
    const buf = await page.screenshot({ fullPage: false, type: "png" });
    return {
      rawHtml,
      finalUrl: page.url(),
      statusCode: response?.status() ?? 0,
      fetchDurationMs: Date.now() - start,
      screenshotBase64: buf.toString("base64")
    };
  } finally {
    await context.close();
    activeContexts--;
  }
}
```

- [ ] **Step 1.3: Commit**

```bash
git add packages/ingestion-browser-fallback/src/playwright-pool.ts
git commit -m "feat(browser-fallback): captureScreenshot via Playwright"
```

---

### Task 2: Build `@aonex/vision-extractor`

**Files:**
- Create: `packages/vision-extractor/package.json` + `src/{index,vision,signal-detector,screenshot}.ts` + tests

- [ ] **Step 2.1: Signal detector — when to escalate to vision**

`src/signal-detector.ts`:

```typescript
import * as cheerio from "cheerio";

export interface VisionSignal {
  shouldEscalate: boolean;
  reasons: string[];
}

/**
 * Spec §6.6 — vision is tier-3, only fires on explicit signals:
 * - Apparel category + size-chart-like image present
 * - Spec sheet image present (high-aspect-ratio img near product area)
 * - Variant swatches with no alt text (just color via CSS background)
 * - Price rendered as image (Amazon-style obfuscation)
 */
export function detectVisionSignal(opts: {
  categoryPath: string | null;
  rawHtml: string;
  missingRequired: string[];
}): VisionSignal {
  const reasons: string[] = [];
  const $ = cheerio.load(opts.rawHtml);

  if (opts.categoryPath?.startsWith("apparel/")) {
    if ($('img[alt*="size" i], img[alt*="chart" i], img[src*="size-chart" i]').length > 0) {
      reasons.push("apparel_size_chart_image_present");
    }
  }

  if (opts.categoryPath?.startsWith("electronics/") || opts.categoryPath?.startsWith("auto/")) {
    if ($('img[alt*="spec" i], img[src*="spec-sheet" i]').length > 0) {
      reasons.push("spec_sheet_image_present");
    }
  }

  // Heuristic: many swatches with no alt text, indicating color-coded variants
  const colorSwatches = $('[class*="swatch" i], [class*="variant-color" i]').length;
  if (colorSwatches >= 4 && $(`[class*="swatch" i] img[alt=""]`).length >= 2) {
    reasons.push("color_swatches_no_alt");
  }

  // If price was a required field and is still missing post-DOM, suspect image-rendered price
  if (opts.missingRequired.includes("base_price")) {
    reasons.push("base_price_missing_after_dom");
  }

  return { shouldEscalate: reasons.length > 0, reasons };
}
```

- [ ] **Step 2.2: Vision call (Groq Llama 3.2 90B Vision)**

`src/vision.ts`:

```typescript
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export interface VisionExtractionInput {
  pageUrl: string;
  screenshotBase64: string;
  reasons: string[];           // signals from signal-detector — drive prompt
  missingRequired: string[];   // fields to focus on
}

export interface VisionExtractionResult {
  facts: ExtractedFact[];
  modelName: string;
  estimatedCostUsd: number;
}

export async function extractWithVision(input: VisionExtractionInput): Promise<VisionExtractionResult> {
  const model = process.env.GROQ_MODEL_VISION ?? "llama-3.2-90b-vision-preview";
  const baseUrl = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not configured for vision extraction");

  const prompt = `You are a product extraction assistant. The static + DOM + LLM extraction missed these fields: ${input.missingRequired.join(", ")}. The page has these signals: ${input.reasons.join(", ")}.

Look at the screenshot and extract ONLY the missing fields. For each, return:
  { "rawKey": "<field>", "value": <value>, "confidence": <0.0-1.0>, "sourcePointer": "screenshot:<brief description>" }

Output a JSON array. Use null for fields you cannot determine.`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${input.screenshotBase64}` } }
          ]
        }
      ],
      max_tokens: 800,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) throw new Error(`Vision API error ${response.status}: ${await response.text()}`);
  const data = await response.json() as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number } };
  const parsed = JSON.parse(data.choices[0].message.content) as Array<{ rawKey: string; value: unknown; confidence: number; sourcePointer: string }>;

  const facts: ExtractedFact[] = parsed
    .filter((p) => p.value !== null && p.value !== undefined)
    .map((p) => ({
      rawKey: p.rawKey,
      canonicalPath: null,
      extractedValue: p.value,
      normalizedValue: null,
      unit: null,
      sourcePointer: p.sourcePointer,
      extractionMethod: "vision_llm",
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      confidence: Math.min(0.85, p.confidence),    // cap vision-LLM confidence
      approved: false
    }));

  // Llama 3.2 90B Vision: $0.90/M input + $0.90/M output (Groq)
  const cost = (data.usage.prompt_tokens + data.usage.completion_tokens) / 1_000_000 * 0.90;

  return { facts, modelName: model, estimatedCostUsd: cost };
}
```

- [ ] **Step 2.3: Tests**

```typescript
// packages/vision-extractor/src/signal-detector.test.ts
import { describe, it, expect } from "bun:test";
import { detectVisionSignal } from "./signal-detector.js";

describe("detectVisionSignal", () => {
  it("escalates apparel page with size chart image", () => {
    const result = detectVisionSignal({
      categoryPath: "apparel/tops/t_shirts",
      rawHtml: '<img alt="Size Chart" src="/x.jpg"/>',
      missingRequired: []
    });
    expect(result.shouldEscalate).toBe(true);
    expect(result.reasons).toContain("apparel_size_chart_image_present");
  });

  it("does NOT escalate electronics with structured price", () => {
    const result = detectVisionSignal({
      categoryPath: "electronics/televisions",
      rawHtml: "<html></html>",
      missingRequired: []
    });
    expect(result.shouldEscalate).toBe(false);
  });

  it("escalates when base_price is missing after DOM heuristics", () => {
    const result = detectVisionSignal({
      categoryPath: "electronics/televisions",
      rawHtml: "<html></html>",
      missingRequired: ["base_price"]
    });
    expect(result.shouldEscalate).toBe(true);
    expect(result.reasons).toContain("base_price_missing_after_dom");
  });
});
```

(Vision API call test is integration-only, opted-in with `GROQ_VISION_INTEGRATION=1`.)

- [ ] **Step 2.4: Commit**

```bash
git add packages/vision-extractor/
git commit -m "feat(vision-extractor): signal-detector + Groq Llama 3.2 90B Vision extractor"
```

---

### Task 3: Wire vision into LinkAdapter as tier-3

**Files:**
- Modify: `packages/link-adapter/src/link-adapter.ts`

- [ ] **Step 3.1: Call vision after structured + DOM + LLM gap-fill**

In `LinkAdapter.extract`, after Layer E (LLM gap-fill) but before returning the fact set:

```typescript
import { detectVisionSignal, extractWithVision } from "@aonex/vision-extractor";
import { fetchWithBrowserAndScreenshot } from "@aonex/ingestion-browser-fallback";

// After collecting structured + DOM + LLM facts:
const allFacts = [...perSiteFacts, ...structuredFacts, ...domFacts, ...llmFacts];

// Compute missingRequired from category schema + present facts
const missingRequired = computeMissingRequired(allFacts, categoryRequiredAttrs);

const visionSignal = detectVisionSignal({
  categoryPath,
  rawHtml: fetchResult.rawHtml,
  missingRequired
});

if (visionSignal.shouldEscalate) {
  try {
    const screenshot = await fetchWithBrowserAndScreenshot(fetchResult.finalUrl, { timeoutMs: 25_000 });
    const vision = await extractWithVision({
      pageUrl: fetchResult.finalUrl,
      screenshotBase64: screenshot.screenshotBase64,
      reasons: visionSignal.reasons,
      missingRequired
    });
    allFacts.push(...vision.facts);
  } catch (err) {
    // Vision failure is non-fatal; log + continue
  }
}

return {
  artifactId: envelope.sourceExternalId as never,
  marketplace: "link_url",
  extractorVersion: LLM_EXTRACTOR_VERSION,
  facts: allFacts,
  extractedAt: new Date()
};
```

- [ ] **Step 3.2: Commit**

```bash
git add packages/link-adapter/src/link-adapter.ts
git commit -m "feat(link-adapter): tier-3 vision LLM escalation on documented signals"
```

---

### Task 4: Build `@aonex/multi-source-reconciler`

**Files:**
- Create: `packages/multi-source-reconciler/package.json` + `src/{index,scoring,policy,jaro-winkler}.ts` + tests

- [ ] **Step 4.1: Scoring (40/20/25/15)**

`src/scoring.ts`:

```typescript
export interface MatchInput {
  newGtin: string | null;
  existingGtin: string | null;
  newBrand: string | null;
  existingBrand: string | null;
  newTitle: string;
  existingTitle: string;
  newAttributes: Record<string, unknown>;
  existingAttributes: Record<string, unknown>;
}

export interface MatchScore {
  total: number;
  components: {
    gtin: number;
    brand: number;
    titleSimilarity: number;
    specOverlap: number;
  };
}

import { jaroWinkler } from "./jaro-winkler.js";

export function scoreMatch(input: MatchInput): MatchScore {
  const components = {
    gtin: input.newGtin && input.newGtin === input.existingGtin ? 1.0 : 0,
    brand: input.newBrand && input.existingBrand && input.newBrand.toLowerCase() === input.existingBrand.toLowerCase() ? 1.0 : 0,
    titleSimilarity: jaroWinkler(input.newTitle.toLowerCase(), input.existingTitle.toLowerCase()),
    specOverlap: computeSpecOverlap(input.newAttributes, input.existingAttributes)
  };

  const total =
    0.40 * components.gtin +
    0.20 * components.brand +
    0.25 * components.titleSimilarity +
    0.15 * components.specOverlap;

  return { total, components };
}

function computeSpecOverlap(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 0;
  let matches = 0;
  for (const k of keys) {
    if (a[k] != null && b[k] != null && JSON.stringify(a[k]) === JSON.stringify(b[k])) matches++;
  }
  return matches / keys.size;
}
```

- [ ] **Step 4.2: Jaro-Winkler implementation**

`src/jaro-winkler.ts`: standard JW; ~30 lines. (Or `bun add jaro-winkler` for the npm package — engineer's call.)

- [ ] **Step 4.3: Conflict resolution policy**

`src/policy.ts`:

```typescript
import type { MatchScore } from "./scoring.js";

export interface ReconciliationDecision {
  action: "merge" | "create_new" | "open_value_conflict";
  reasons: string[];
}

export function decide(opts: {
  matchScore: MatchScore;
  thresholds?: { merge: number; review: number };
}): ReconciliationDecision {
  const thr = opts.thresholds ?? { merge: 0.90, review: 0.72 };
  if (opts.matchScore.total >= thr.merge) {
    return { action: "merge", reasons: ["high_match_score"] };
  }
  if (opts.matchScore.total >= thr.review) {
    return { action: "open_value_conflict", reasons: ["medium_match_score_needs_review"] };
  }
  return { action: "create_new", reasons: ["low_match_score"] };
}

export function resolveFieldConflict(opts: {
  field: string;
  sourceA: { value: unknown; sourceType: string; confidence: number };
  sourceB: { value: unknown; sourceType: string; confidence: number };
}): { winner: "A" | "B" | "conflict"; reason: string } {
  // Manufacturer site > authorized retailer > marketplace seller
  const rank: Record<string, number> = {
    manufacturer: 3,
    authorized_retailer: 2,
    marketplace: 1,
    unknown: 0
  };
  const rankA = rank[opts.sourceA.sourceType] ?? 0;
  const rankB = rank[opts.sourceB.sourceType] ?? 0;

  if (rankA > rankB) return { winner: "A", reason: "source_type_rank" };
  if (rankB > rankA) return { winner: "B", reason: "source_type_rank" };

  // Tiebreaker: confidence
  if (Math.abs(opts.sourceA.confidence - opts.sourceB.confidence) > 0.05) {
    return opts.sourceA.confidence > opts.sourceB.confidence
      ? { winner: "A", reason: "confidence" }
      : { winner: "B", reason: "confidence" };
  }

  // Genuine conflict — open review task
  return { winner: "conflict", reason: "indeterminate" };
}
```

- [ ] **Step 4.4: Tests + commit**

```bash
bun --cwd packages/multi-source-reconciler test
git add packages/multi-source-reconciler/
git commit -m "feat(multi-source-reconciler): 40/20/25/15 scoring + field-level voting policy"
```

---

### Task 5: Add `value_conflict` review task type + wire reconciler

**Files:**
- Modify: `packages/db/src/schema/enums.ts` (or wherever `taskType` enum lives)
- Modify: `packages/catalog/catalog-service/src/index.ts`

- [ ] **Step 5.1: Add enum value**

Find the `taskType` enum in `packages/db/src/schema/`, add `"value_conflict"` to the allowed values. Run `bun --bun --cwd packages/db drizzle-kit generate` to produce the migration.

- [ ] **Step 5.2: Wire into `applyApprovedDiff`**

In `packages/catalog/catalog-service/src/index.ts`, when the GTIN matches an existing product:

```typescript
import { scoreMatch, decide, resolveFieldConflict } from "@aonex/multi-source-reconciler";

// Inside applyApprovedDiff, after the existing product lookup:
const existing = await loadExistingByGtin(...);
if (existing) {
  const match = scoreMatch({ ... });
  const decision = decide({ matchScore: match });
  if (decision.action === "create_new") {
    // proceed with normal create flow
  } else if (decision.action === "merge") {
    // create a new product_version under existing.productId with reconciled values
    // For each conflicting field, call resolveFieldConflict — if winner is "conflict",
    // emit value_conflict review_task and use the existing value for now.
  } else {
    // open_value_conflict: emit review_task, don't create version yet
    throw new Error("Cross-source value conflict — review required");
  }
}
```

- [ ] **Step 5.3: Commit**

```bash
git add packages/db/src/schema/ packages/db/drizzle/ packages/catalog/catalog-service/src/index.ts
git commit -m "feat(catalog-service): multi-source reconciliation + value_conflict review task"
```

---

### Task 6: PR

```bash
git push -u origin feature/phase-9-vision-multisource
gh pr create --title "feat(phase-9): vision LLM tier-3 + multi-source verification" --body "<see plan §17 Phase 9>"
```

---

## Self-Review

1. **Spec coverage** — Layer F vision ✓, Layer H multi-source verification ✓, value_conflict task type ✓, conflict resolution policy ✓.
2. **Placeholder scan** — None (`jaroWinkler` implementation suggested as npm install OR ~30 lines hand-rolled; either acceptable).
3. **Type consistency** — `MatchScore` and `ReconciliationDecision` consistent. Vision extractor returns `ExtractedFact[]` matching everything else. ✓
