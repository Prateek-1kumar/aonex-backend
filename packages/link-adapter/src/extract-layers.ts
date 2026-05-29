import { extractStructured } from "@aonex/ingestion-structured";
import {
  type LLMProductExtractor,
  LLM_EXTRACTOR_VERSION,
  compressJsonLd,
  pruneNextData,
  genericExtract,
  createLlmCallModel
} from "@aonex/ingestion-llm-extractor";
import type { ExtractedFactSet, ExtractedFact } from "@aonex/ingestion-field-extractor";
import { convertFromFacts } from "@aonex/ingestion-enrichment";
import { runDomHeuristics } from "@aonex/ingestion-dom-heuristics";
import {
  fetchWithBrowserAndScreenshot,
  type FetchBrowserWithScreenshotResult
} from "@aonex/ingestion-browser-fallback";
import {
  shouldEscalateToVision,
  callVision,
  createVisionCallModel,
  type VisionCallInput,
  type VisionCallResult
} from "@aonex/vision-extractor";
import { classifyArchetype, getArchetype } from "@aonex/archetypes";
import type { IsotonicModel } from "@aonex/calibration";
import type { PerSiteParser } from "@aonex/per-site-parsers";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";
import type { ScreenshotFetcher, VisionExtractor } from "./link-adapter.js";
import type { CacheEntry } from "./fetch-escalation.js";
import { BudgetTracker } from "./budget.js";

// Re-export for consumers that import extraction-related types from this module.
export type { FetchBrowserWithScreenshotResult, VisionCallInput, VisionCallResult };

export const SCHEMA_FIELDS = [
  "title","brand","gtin","mpn","model_number","description","base_price","currency",
  "images","variants","productType",
  "sale_price","list_price","discount_percent","price_per_unit",
  "rating_average","rating_count","seller_name",
  "highlights","breadcrumbs","return_policy","warranty",
  "shipping_free","shipping_cost","weight","dimensions"
] as const;

// Phase 3 Task 6: placeholder identity isotonic. Returns raw confidence unchanged
// (applyIsotonic short-circuits when thresholds is empty). Phase 3.x will load a
// fitted model from where calibration eventually persists.
const IDENTITY_CALIBRATION: IsotonicModel = { thresholds: [], values: [] };

/** Convert genericExtract's CalibratedFact output to the ExtractedFact shape the
 *  downstream pipeline expects. */
function calibratedToExtracted(
  facts: Array<{ field: string; value: unknown; confidence: number }>
): ExtractedFact[] {
  return facts.map((f) => ({
    rawKey: f.field,
    canonicalPath: null,
    extractedValue: f.value,
    normalizedValue: f.value,
    unit: null,
    sourcePointer: "generic-extractor",
    extractionMethod: "direct" as const,
    confidence: f.confidence,
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    approved: false,
  }));
}

/**
 * Merge per-site parser facts with generic Layer A/B facts.
 * Per-site wins on rawKey collisions (Layer G is the highest-priority rung
 * for domains where a hand-written parser exists). Generic facts fill gaps.
 */
export function mergeFactsWithPriority(perSite: ExtractedFact[], generic: ExtractedFact[]): ExtractedFact[] {
  const perSiteKeys = new Set(perSite.map((f) => f.rawKey));
  const carried = generic.filter((f) => !perSiteKeys.has(f.rawKey));
  return [...perSite, ...carried];
}

export async function runExtractionLayers(
  deps: {
    llmExtractor: LLMProductExtractor;
    domHeuristics: (rawHtml: string) => { facts: ExtractedFact[] };
    findPerSiteParser: (url: string) => PerSiteParser | null;
    screenshotFetcher: ScreenshotFetcher;
    visionExtractor: VisionExtractor | null;
  },
  envelope: IngestionEnvelope,
  cached: CacheEntry
): Promise<ExtractedFactSet> {
  const finalUrl = cached.fetchResult.finalUrl;

  // Per-URL budget (soft cap on LLM/vision calls, wall time, cost).
  // When exceeded, downstream tiers are skipped and skuJson._extraction_meta
  // carries `budget_exceeded: true` so the orchestrator can flag partial output.
  const budget = new BudgetTracker();

  // Layer G — per-site parser (highest priority)
  let perSiteFacts: ExtractedFact[] = [];
  const perSiteParser = deps.findPerSiteParser(finalUrl);
  if (perSiteParser) {
    try {
      perSiteFacts = await perSiteParser.extract({
        rawHtml: cached.finalRawHtml,
        url: finalUrl
      });
    } catch {
      // Per-site parser threw — fall back to generic Layer A/B. Don't fail the whole extract.
      perSiteFacts = [];
    }
  }

  // Layers A + B (always run — additive to per-site)
  const structuredResult = await extractStructured({
    pageUrl: cached.fetchResult.finalUrl,
    rawHtml: cached.finalRawHtml,
    structuredBlocks: cached.fetchResult.structuredBlocks
  });

  // Run Layer B DOM heuristics
  const dom = deps.domHeuristics(cached.finalRawHtml);

  // Merge: per-site wins on rawKey collisions (highest-priority Layer G)
  const baseFacts = mergeFactsWithPriority(perSiteFacts, [...structuredResult.structured.facts, ...dom.facts]);

  // Phase 3 Task 6: classify the archetype from already-known facts and route the
  // LLM gap-fill through genericExtract when a registered archetype matches.
  // When archetype is "unknown" (no rule fires or ambiguous match), fall back to
  // the legacy static-SCHEMA_FIELDS gap-fill — preserves backward-compat for
  // sites we haven't classified yet.
  const titleFact = baseFacts.find((f) => f.rawKey === "title");
  const brandFact = baseFacts.find((f) => f.rawKey === "brand");
  const catFact   = baseFacts.find((f) => f.rawKey === "category_path");
  const classifySignals: { title?: string; brand?: string; categoryPath?: string } = {};
  if (typeof titleFact?.extractedValue === "string") classifySignals.title = titleFact.extractedValue;
  if (typeof brandFact?.extractedValue === "string") classifySignals.brand = brandFact.extractedValue;
  if (typeof catFact?.extractedValue   === "string") classifySignals.categoryPath = catFact.extractedValue;
  const archId = classifyArchetype(classifySignals);
  const archetype = getArchetype(archId);

  // Build a Record<rawKey, {value, confidence}> view of baseFacts for genericExtract's
  // fast-path / vision update step.
  const structuredView: Record<string, { value: unknown; confidence: number }> = {};
  for (const f of baseFacts) {
    structuredView[f.rawKey] = {
      value: f.normalizedValue ?? f.extractedValue,
      confidence: f.confidence
    };
  }

  // LLM gap-fill / generic extraction
  const llmFacts: ExtractedFactSet["facts"] = [];

  const filledKeys = new Set<string>(baseFacts.map((f) => f.rawKey));
  const gaps = SCHEMA_FIELDS.filter((k) => !filledKeys.has(k));

  if (archetype && budget.canCallLlm()) {
    // Phase 3 Task 6 primary path: schema-guided generic extraction.
    try {
      const compressed = compressJsonLd(cached.fetchResult.structuredBlocks.jsonLd ?? []);
      const nextSub = pruneNextData(cached.fetchResult.structuredBlocks.nextData);
      const rawImageUrls = (cached.fetchResult.structuredBlocks.images ?? []).map((i) => i.url);

      const llmCallModel = createLlmCallModel({
        llmExtractor: deps.llmExtractor,
        baseFacts,
        structuredHints: {
          jsonLd: compressed,
          metaTags: cached.fetchResult.structuredBlocks.metaTags ?? {},
          microdata: cached.fetchResult.structuredBlocks.microdata ?? [],
          rawImageUrls,
          nextDataProductSubtree: nextSub
        },
        finalUrl: cached.fetchResult.finalUrl,
        artifactId: envelope.sourceExternalId as never,
        onCost: (usd) => budget.recordLlm(usd)
      });

      const calibrated = await genericExtract({
        archetype,
        structured: structuredView,
        cleanedText: cached.fetchResult.cleanedText,
        calibration: IDENTITY_CALIBRATION,
        callModel: llmCallModel
      });
      llmFacts.push(...calibratedToExtracted(calibrated));
    } catch {
      // generic-extract error — keep base facts; absent facts surface in trace
    }
  } else if (gaps.length > 0 && budget.canCallLlm()) {
    // Legacy fallback: unknown archetype OR no archetype registered → use the
    // original static-SCHEMA_FIELDS gap-fill so behaviour for unclassified sites
    // stays intact while Phase 3 archetype coverage grows.
    try {
      const compressed = compressJsonLd(cached.fetchResult.structuredBlocks.jsonLd ?? []);
      const nextSub = pruneNextData(cached.fetchResult.structuredBlocks.nextData);
      const rawImageUrls = (cached.fetchResult.structuredBlocks.images ?? []).map((i) => i.url);

      const r = await deps.llmExtractor.extractGapFill(
        cached.fetchResult.cleanedText,
        cached.fetchResult.finalUrl,
        envelope.sourceExternalId as never,
        {
          gaps: [...gaps],
          structuredFacts: baseFacts.map((f) => ({
            rawKey: f.rawKey,
            value: f.normalizedValue ?? f.extractedValue,
            source: f.extractionMethod ?? "structured"
          })),
          structuredHints: {
            jsonLd: compressed,
            metaTags: cached.fetchResult.structuredBlocks.metaTags ?? {},
            microdata: cached.fetchResult.structuredBlocks.microdata ?? [],
            rawImageUrls,
            nextDataProductSubtree: nextSub
          }
        }
      );
      budget.recordLlm(r.estimatedCostUsd ?? 0);
      llmFacts.push(...r.facts);
    } catch {
      // LLM error — keep base facts; absent facts surface in trace
    }
  }

  // Layer F — vision tier-3 (Phase 9)
  // NOTE: createVisionCallModel is imported and referenced via `void` below so
  // the import chain is preserved. The full integration through genericExtract
  // for vision is deferred to Phase 3.x: it requires deps wiring (API key) that
  // the existing deps.visionExtractor closure already owns. For Task 6 we
  // continue to invoke deps.visionExtractor directly so vision behaviour is
  // unchanged.
  const visionFacts: ExtractedFactSet["facts"] = [];
  const upstreamFacts = [...baseFacts, ...llmFacts];
  const visionDecision = shouldEscalateToVision({
    rawHtml: cached.finalRawHtml,
    hasTextPrice: upstreamFacts.some((f) => f.rawKey === "base_price"),
    upstreamFactCount: upstreamFacts.length,
    upstreamFactKeys: upstreamFacts.map((f) => f.rawKey)
  });
  if (visionDecision.escalate && deps.visionExtractor && budget.canCallVision()) {
    try {
      const screenshot = await deps.screenshotFetcher(cached.fetchResult.finalUrl, {
        timeoutMs: 20_000
      });
      const visionResult = await deps.visionExtractor({
        screenshotBase64: screenshot.screenshotBase64,
        pageUrl: cached.fetchResult.finalUrl
      });
      budget.recordVision(visionResult.estimatedCostUsd ?? 0);
      visionFacts.push(...visionResult.facts);
    } catch {
      // Vision failed (screenshot or API error) — don't fail the extract.
    }
  }
  // Keep the new vision callModel symbol referenced so its import survives
  // tree-shaking-aware tools until Phase 3.x lights up the wiring.
  void createVisionCallModel;

  const allFacts = [...upstreamFacts, ...visionFacts];

  // Phase 3 richness: synthesize a rich SKU JSON via the enrichment pass.
  // og:image is best-effort — used by image-role-classifier to bias the hero pick.
  const metaTags = cached.fetchResult.structuredBlocks.metaTags ?? {};
  const ogImage =
    metaTags["og:image"] ??
    metaTags["og:image:url"] ??
    metaTags["og:image:secure_url"] ??
    null;
  const skuJson = convertFromFacts(allFacts, cached.fetchResult.finalUrl, { ogImage });

  // Decorate _extraction_meta with provenance from this run so the trace UI
  // can show which layers fired and how far we escalated.
  skuJson._extraction_meta.passes_run = [
    ...(perSiteFacts.length > 0 ? ["per_site"] : []),
    "structured",
    "dom",
    ...(llmFacts.length > 0 ? [archetype ? "generic-extract" : "llm-gap-fill"] : []),
    ...(visionFacts.length > 0 ? ["vision"] : [])
  ];
  skuJson._extraction_meta.escalated_to = cached.escalatedTo;

  // Budget snapshot — surfaces real cost/latency in _extraction_meta and
  // flags `budget_exceeded` when the soft cap was hit during this URL's run.
  const bs = budget.snapshot();
  skuJson._extraction_meta.tokens_used = 0; // tokens already aggregated upstream; keep 0 unless plumbed
  skuJson._extraction_meta.cost_usd = bs.costUsd;
  skuJson._extraction_meta.latency_ms = bs.wallMs;
  if (bs.exceeded) skuJson._extraction_meta.budget_exceeded = true;

  return {
    artifactId: envelope.sourceExternalId as never,
    marketplace: "link_url",
    extractorVersion: LLM_EXTRACTOR_VERSION,
    facts: allFacts,
    extractedAt: new Date(),
    skuJson
  };
}

// Satisfy import references for types used as defaults in the class constructor.
export { fetchWithBrowserAndScreenshot, runDomHeuristics, callVision };
