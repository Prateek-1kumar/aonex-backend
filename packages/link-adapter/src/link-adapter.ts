import type { IngestionAdapter, IngestionEnvelope } from "@aonex/ingestion-spine";
import { fetchLink } from "@aonex/ingestion-link-fetcher";
import { type LLMProductExtractor } from "@aonex/ingestion-llm-extractor";
import type { ExtractedFactSet, ExtractedFact } from "@aonex/ingestion-field-extractor";
import { runDomHeuristics } from "@aonex/ingestion-dom-heuristics";
import {
  fetchWithBrowser,
  fetchWithBrowserAndScreenshot,
  type FetchBrowserResult,
  type FetchBrowserWithScreenshotResult
} from "@aonex/ingestion-browser-fallback";
import {
  callVision,
  type VisionCallInput,
  type VisionCallResult
} from "@aonex/vision-extractor";
import {
  createScrapingBeeAdapter,
  type UnblockResult
} from "@aonex/ingestion-antibot-vendor";
import { findParserForUrl } from "@aonex/per-site-parsers";
import type { PerSiteParser } from "@aonex/per-site-parsers";
import { FileEscalationCache, type IEscalationCache } from "./escalation-cache.js";
import { runFetchEscalation, type CacheEntry } from "./fetch-escalation.js";
import { runExtractionLayers } from "./extract-layers.js";

// Local AdapterInput type — internal to ingestion-spine, not re-exported.
interface AdapterInput {
  sourceRef: string;
  hints?: { categoryHint?: string; localeHint?: string };
}

export type EscalatedTo = "static" | "browser" | "unblock";

export interface BrowserFetcher {
  (url: string, opts?: { timeoutMs?: number }): Promise<FetchBrowserResult>;
}

export interface ScreenshotFetcher {
  (url: string, opts?: { timeoutMs?: number; screenshotSelector?: string }): Promise<FetchBrowserWithScreenshotResult>;
}

export interface VisionExtractor {
  (input: VisionCallInput): Promise<VisionCallResult>;
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
  /** Layer F — vision tier-3. When omitted, defaults to fetchWithBrowserAndScreenshot. */
  screenshotFetcher?: ScreenshotFetcher;
  /** Layer F — vision LLM call. When omitted AND GROQ_API_KEY/OPENAI_API_KEY env is set, defaults to callVision with that key.
   *  When omitted AND env unset, vision is DISABLED (signal can fire but no extraction). */
  visionExtractor?: VisionExtractor;
  /** Cold-path escalation cache. Defaults to FileEscalationCache at ESCALATION_CACHE_PATH
   *  (or /tmp/aonex-escalation.json). Stubbable for tests (InMemoryEscalationCache). */
  cache?: IEscalationCache;
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
    screenshotFetcher: ScreenshotFetcher;
    /** Null when no API key is available — vision is disabled in that case. */
    visionExtractor: VisionExtractor | null;
    cache: IEscalationCache;
  };
  private readonly cache = new Map<string, CacheEntry>();

  constructor(deps: LinkAdapterDeps) {
    const apiKey = process.env["GROQ_API_KEY"] ?? process.env["OPENAI_API_KEY"];
    const defaultVision: VisionExtractor | null = apiKey
      ? (input) => callVision(input, { apiKey })
      : null;

    this.deps = {
      fetcher: deps.fetcher ?? fetchLink,
      llmExtractor: deps.llmExtractor,
      browserFetcher: deps.browserFetcher ?? fetchWithBrowser,
      unblockAdapter: deps.unblockAdapter ?? null,
      domHeuristics: deps.domHeuristics ?? runDomHeuristics,
      findPerSiteParser: deps.findPerSiteParser ?? findParserForUrl,
      screenshotFetcher: deps.screenshotFetcher ?? fetchWithBrowserAndScreenshot,
      visionExtractor: deps.visionExtractor !== undefined ? deps.visionExtractor : defaultVision,
      cache: deps.cache ?? new FileEscalationCache(process.env["ESCALATION_CACHE_PATH"] ?? "/tmp/aonex-escalation.json")
    };
  }

  async *normalize(input: AdapterInput): AsyncIterable<IngestionEnvelope> {
    const { cacheEntry, envelope } = await runFetchEscalation(this.deps, input);

    // Store in the in-process cache for extract() to pick up.
    this.cache.set(envelope.sourceExternalId, cacheEntry);

    // Persist escalation state to disk so cold-path retries (worker restart)
    // can replay the browser/unblock decision instead of silently falling
    // back to static-only.
    await this.deps.cache.set(envelope.sourceExternalId, {
      escalatedTo: cacheEntry.escalatedTo,
      reasons: cacheEntry.escalationReasons,
      costCredits: cacheEntry.costCredits
    });

    yield envelope;
  }

  async extract(envelope: IngestionEnvelope): Promise<ExtractedFactSet> {
    const cached = this.cache.get(envelope.sourceExternalId);
    if (!cached) {
      // Cold adapter — check the persistent escalation cache. If this URL
      // previously needed browser/unblock, replay the ladder by re-running
      // normalize(); otherwise fall back to a plain static re-fetch.
      const prior = await this.deps.cache.get(envelope.sourceExternalId);
      if (prior && prior.escalatedTo !== "static") {
        const it = this.normalize({ sourceRef: envelope.sourceExternalId });
        for await (const _ of it) {
          /* consume; populates this.cache */
        }
        return this.extract(envelope);
      }
      // Static-only fallback
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

    return runExtractionLayers(this.deps, envelope, cached);
  }
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
