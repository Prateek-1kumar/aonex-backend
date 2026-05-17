import type { IngestionAdapter, IngestionEnvelope } from "@aonex/ingestion-spine";
import { fetchLink, type LinkFetchResult } from "@aonex/ingestion-link-fetcher";
import { extractStructured } from "@aonex/ingestion-structured";
import { LLMProductExtractor, LLM_EXTRACTOR_VERSION } from "@aonex/ingestion-llm-extractor";
import type { ExtractedFactSet, ExtractedFact } from "@aonex/ingestion-field-extractor";
import { runDomHeuristics } from "@aonex/ingestion-dom-heuristics";
import {
  fetchWithBrowser,
  shouldEscalateToBrowser,
  type FetchBrowserResult
} from "@aonex/ingestion-browser-fallback";
import {
  createScrapingBeeAdapter,
  withinCostCeiling,
  type UnblockResult
} from "@aonex/ingestion-antibot-vendor";
import { findParserForUrl } from "@aonex/per-site-parsers";
import type { PerSiteParser } from "@aonex/per-site-parsers";

// Local AdapterInput type — internal to ingestion-spine, not re-exported.
interface AdapterInput {
  sourceRef: string;
  hints?: { categoryHint?: string; localeHint?: string };
}

export type EscalatedTo = "static" | "browser" | "unblock";

export interface BrowserFetcher {
  (url: string, opts?: { timeoutMs?: number }): Promise<FetchBrowserResult>;
}

/**
 * Structural interface for the unblock vendor adapter.
 * Matches the ScrapingBeeAdapter shape from @aonex/ingestion-antibot-vendor
 * (defined locally to avoid re-exporting from that package's internal index).
 */
export interface UnblockAdapter {
  unblock(url: string, opts?: { premiumProxy?: boolean; jsRendering?: boolean; countryCode?: string }): Promise<UnblockResult>;
}

export interface LinkAdapterDeps {
  fetcher?: typeof fetchLink;
  llmExtractor: LLMProductExtractor;
  /** Layer C — Playwright browser fallback. Inject a stub for tests. */
  browserFetcher?: BrowserFetcher;
  /** Layer D — ScrapingBee unblock. Optional; only fires when within cost ceiling and previous escalations failed. */
  unblockAdapter?: UnblockAdapter;
  /** Layer B — DOM heuristics runner. Defaults to `runDomHeuristics`; stubbable for tests. */
  domHeuristics?: (rawHtml: string) => { facts: ExtractedFact[] };
  /** Layer G — per-site parser lookup. Defaults to findParserForUrl from @aonex/per-site-parsers. Stubbable for tests. */
  findPerSiteParser?: (url: string) => PerSiteParser | null;
}

interface CacheEntry {
  fetchResult: LinkFetchResult;
  finalRawHtml: string;
  escalatedTo: EscalatedTo;
  costCredits: number;
  escalationReasons: string[];
}

class LinkAdapter implements IngestionAdapter {
  readonly lane = "link" as const;
  private readonly deps: {
    fetcher: typeof fetchLink;
    llmExtractor: LLMProductExtractor;
    browserFetcher: BrowserFetcher;
    unblockAdapter: UnblockAdapter | null;
    domHeuristics: (rawHtml: string) => { facts: ExtractedFact[] };
    findPerSiteParser: (url: string) => PerSiteParser | null;
  };
  private readonly cache = new Map<string, CacheEntry>();

  constructor(deps: LinkAdapterDeps) {
    this.deps = {
      fetcher: deps.fetcher ?? fetchLink,
      llmExtractor: deps.llmExtractor,
      browserFetcher: deps.browserFetcher ?? fetchWithBrowser,
      unblockAdapter: deps.unblockAdapter ?? null,
      domHeuristics: deps.domHeuristics ?? runDomHeuristics,
      findPerSiteParser: deps.findPerSiteParser ?? findParserForUrl
    };
  }

  async *normalize(input: AdapterInput): AsyncIterable<IngestionEnvelope> {
    const staticResult = await this.deps.fetcher(input.sourceRef);

    // Quick coverage probe on the static fetch result
    const hasJsonLd = staticResult.structuredBlocks.jsonLd.length > 0;
    const hasNextData = staticResult.structuredBlocks.nextData !== null;
    const hasNuxt = /window\.__NUXT__\s*=/.test(staticResult.rawHtml);
    const coveragePercent = hasJsonLd ? 0.8 : (hasNextData || hasNuxt) ? 0.7 : 0.3;

    const decision = shouldEscalateToBrowser({
      rawHtml: staticResult.rawHtml,
      hasJsonLd,
      hasNextData,
      hasNuxt,
      coveragePercent
    });

    let finalRawHtml = staticResult.rawHtml;
    let escalatedTo: EscalatedTo = "static";
    let costCredits = 0;

    if (decision.escalate) {
      try {
        const browserResult = await this.deps.browserFetcher(input.sourceRef, { timeoutMs: 20_000 });
        finalRawHtml = browserResult.rawHtml;
        escalatedTo = "browser";
      } catch {
        // Browser-fallback failed — try unblock vendor (paid) if available + within budget.
        if (this.deps.unblockAdapter && withinCostCeiling(costCredits, 5)) {
          try {
            const unblockResult: UnblockResult = await this.deps.unblockAdapter.unblock(input.sourceRef, {
              premiumProxy: true,
              jsRendering: true
            });
            finalRawHtml = unblockResult.rawHtml;
            escalatedTo = "unblock";
            costCredits += unblockResult.costCredits;
          } catch {
            // Both browser and unblock failed — keep the static HTML; downstream
            // parsers will yield few facts but the run completes.
          }
        }
      }
    }

    this.cache.set(staticResult.finalUrl, {
      fetchResult: staticResult,
      finalRawHtml,
      escalatedTo,
      costCredits,
      escalationReasons: decision.reasons
    });

    const hints = input.hints;
    yield {
      sourceExternalId: staticResult.finalUrl,
      sourceType: "link_url",
      sourceMarketplace: null,
      rawData: {
        url: staticResult.url,
        finalUrl: staticResult.finalUrl,
        statusCode: staticResult.statusCode,
        contentType: staticResult.contentType,
        fetchedAt: staticResult.fetchedAt.toISOString(),
        htmlSnippet: finalRawHtml.substring(0, 10_000),
        cleanedTextLength: staticResult.cleanedText.length,
        escalatedTo,
        escalationReasons: decision.reasons,
        costCredits
      },
      checksum: staticResult.contentChecksum,
      // exactOptionalPropertyTypes: spread the key in only when there are hints
      // so we never set extractionHints to undefined explicitly.
      ...(hints !== undefined
        ? {
            extractionHints: {
              ...(hints.categoryHint !== undefined ? { categoryHint: hints.categoryHint } : {}),
              ...(hints.localeHint !== undefined ? { localeHint: hints.localeHint } : {})
            }
          }
        : {})
    };
  }

  async extract(envelope: IngestionEnvelope): Promise<ExtractedFactSet> {
    const cached = this.cache.get(envelope.sourceExternalId);
    if (!cached) {
      // Cold adapter — re-fetch statically (no escalation since we don't know coverage)
      const result = await this.deps.fetcher(envelope.sourceExternalId);
      this.cache.set(envelope.sourceExternalId, {
        fetchResult: result,
        finalRawHtml: result.rawHtml,
        escalatedTo: "static",
        costCredits: 0,
        escalationReasons: []
      });
      return this.extract(envelope);
    }

    const finalUrl = cached.fetchResult.finalUrl;

    // Layer G — per-site parser (highest priority)
    let perSiteFacts: ExtractedFact[] = [];
    const perSiteParser = this.deps.findPerSiteParser(finalUrl);
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
    const structured = await extractStructured({
      pageUrl: cached.fetchResult.finalUrl,
      rawHtml: cached.finalRawHtml,
      structuredBlocks: cached.fetchResult.structuredBlocks
    });

    // Run Layer B DOM heuristics
    const dom = this.deps.domHeuristics(cached.finalRawHtml);

    // Merge: per-site wins on rawKey collisions (highest-priority Layer G)
    const baseFacts = mergeFactsWithPriority(perSiteFacts, [...structured.structured.facts, ...dom.facts]);

    // LLM gap-fill ONLY if everything above produced nothing
    const llmFacts: ExtractedFactSet["facts"] = [];
    if (baseFacts.length === 0) {
      const r = await this.deps.llmExtractor.extract(
        cached.fetchResult.cleanedText,
        cached.fetchResult.finalUrl,
        envelope.sourceExternalId as never
      );
      llmFacts.push(...r.facts);
    }

    return {
      artifactId: envelope.sourceExternalId as never,
      marketplace: "link_url",
      extractorVersion: LLM_EXTRACTOR_VERSION,
      facts: [...baseFacts, ...llmFacts],
      extractedAt: new Date()
    };
  }
}

/**
 * Merge per-site parser facts with generic Layer A/B facts.
 * Per-site wins on rawKey collisions (Layer G is the highest-priority rung
 * for domains where a hand-written parser exists). Generic facts fill gaps.
 */
function mergeFactsWithPriority(perSite: ExtractedFact[], generic: ExtractedFact[]): ExtractedFact[] {
  const perSiteKeys = new Set(perSite.map((f) => f.rawKey));
  const carried = generic.filter((f) => !perSiteKeys.has(f.rawKey));
  return [...perSite, ...carried];
}

export function createLinkAdapter(deps: LinkAdapterDeps): IngestionAdapter {
  return new LinkAdapter(deps);
}

/**
 * Builds a LinkAdapter with the real ScrapingBee client wired in. Convenience
 * factory for the worker bootstrap (composition-root.ts).
 *
 * Falls back to no unblock layer when SCRAPINGBEE_API_KEY is unset — that's
 * the current Phase 6 default. Layer D goes live in a follow-up.
 */
export async function createLinkAdapterWithAntibot(
  deps: Omit<LinkAdapterDeps, "unblockAdapter">
): Promise<IngestionAdapter> {
  const apiKey = process.env["SCRAPINGBEE_API_KEY"];
  if (!apiKey) return createLinkAdapter(deps);

  // Dynamically import the real ScrapingBee SDK and construct an adapter.
  // createRealScrapingBeeClient is not re-exported from the package index,
  // so we inline the same CJS-interop pattern here.
  type ModShape = {
    ScrapingBeeClient?: new (key: string) => unknown;
    default?: { ScrapingBeeClient?: new (key: string) => unknown };
  };
  const mod = (await import("scrapingbee")) as ModShape;
  const ClientCtor = mod.ScrapingBeeClient ?? mod.default?.ScrapingBeeClient;
  if (!ClientCtor) {
    throw new Error("scrapingbee SDK did not expose ScrapingBeeClient — check SDK version");
  }
  const rawClient = new ClientCtor(apiKey);
  const unblockAdapter = createScrapingBeeAdapter(rawClient as Parameters<typeof createScrapingBeeAdapter>[0]);
  return createLinkAdapter({ ...deps, unblockAdapter });
}

export { LinkAdapter };
