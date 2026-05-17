import type { IngestionAdapter, IngestionEnvelope } from "@aonex/ingestion-spine";
import { fetchLink, type LinkFetchResult } from "@aonex/ingestion-link-fetcher";
import { extractStructured } from "@aonex/ingestion-structured";
import { LLMProductExtractor, LLM_EXTRACTOR_VERSION } from "@aonex/ingestion-llm-extractor";
import type { ExtractedFactSet, ExtractedFact } from "@aonex/ingestion-field-extractor";
import { runDomHeuristics } from "@aonex/ingestion-dom-heuristics";
import {
  fetchWithBrowser,
  fetchWithBrowserAndScreenshot,
  shouldEscalateToBrowser,
  type FetchBrowserResult,
  type FetchBrowserWithScreenshotResult
} from "@aonex/ingestion-browser-fallback";
import {
  shouldEscalateToVision,
  callVision,
  type VisionCallInput,
  type VisionCallResult
} from "@aonex/vision-extractor";
import {
  createScrapingBeeAdapter,
  withinCostCeiling,
  type UnblockResult
} from "@aonex/ingestion-antibot-vendor";
import { findParserForUrl } from "@aonex/per-site-parsers";
import type { PerSiteParser } from "@aonex/per-site-parsers";
import { sha256Hex } from "@aonex/lib-utils";

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
    screenshotFetcher: ScreenshotFetcher;
    /** Null when no API key is available — vision is disabled in that case. */
    visionExtractor: VisionExtractor | null;
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
      visionExtractor: deps.visionExtractor !== undefined ? deps.visionExtractor : defaultVision
    };
  }

  async *normalize(input: AdapterInput): AsyncIterable<IngestionEnvelope> {
    // Per-site parser short-circuit: if a registered parser declares
    // `requiresBrowser: true` for this hostname (Amazon, Walmart, BestBuy),
    // skip the static fetch entirely and go straight to browser. Avoids
    // wasted requests to known-aggressively-bot-walled retailers.
    const perSiteParser = this.deps.findPerSiteParser(input.sourceRef);
    const forceBrowser = perSiteParser?.requiresBrowser === true;

    let staticResult: LinkFetchResult | null = null;
    let staticFetchError: unknown = null;
    if (!forceBrowser) {
      try {
        staticResult = await this.deps.fetcher(input.sourceRef);
      } catch (err) {
        // Static fetch failed (403/captcha/network/timeout). Capture the error
        // and try browser/unblock fallbacks instead of bailing.
        staticFetchError = err;
      }
    }

    // Probe signals when we have a static result. When we don't (forced-browser
    // or fetch failure), set conservative defaults that guarantee escalation.
    const hasJsonLd = staticResult ? staticResult.structuredBlocks.jsonLd.length > 0 : false;
    const hasNextData = staticResult ? staticResult.structuredBlocks.nextData !== null : false;
    const hasNuxt = staticResult ? /window\.__NUXT__\s*=/.test(staticResult.rawHtml) : false;
    const captchaWall = staticResult?.captchaSignal === true;
    const coveragePercent = !staticResult
      ? 0.0
      : captchaWall
        ? 0.1
        : hasJsonLd
          ? 0.8
          : hasNextData || hasNuxt
            ? 0.7
            : 0.3;

    const decision = shouldEscalateToBrowser({
      rawHtml: staticResult?.rawHtml ?? "",
      hasJsonLd,
      hasNextData,
      hasNuxt,
      coveragePercent
    });

    // Force escalation when: static fetch failed OR captcha wall detected OR
    // per-site parser demands browser.
    const mustEscalate =
      forceBrowser || staticFetchError !== null || captchaWall || decision.escalate;
    const escalationReasons = [...decision.reasons];
    if (forceBrowser) escalationReasons.push("per_site_parser_requires_browser");
    if (staticFetchError !== null) {
      const msg = staticFetchError instanceof Error ? staticFetchError.message : String(staticFetchError);
      escalationReasons.push(`static_fetch_failed:${msg.slice(0, 80)}`);
    }
    if (captchaWall) escalationReasons.push("captcha_wall_signal");

    let finalRawHtml = staticResult?.rawHtml ?? "";
    let escalatedTo: EscalatedTo = "static";
    let costCredits = 0;
    /** Set once we have a usable response (static OR browser OR unblock). */
    let resolvedFinalUrl = staticResult?.finalUrl ?? input.sourceRef;
    let resolvedStatusCode = staticResult?.statusCode ?? 0;
    let resolvedContentType = staticResult?.contentType ?? "text/html";

    if (mustEscalate) {
      // Layer C — browser fallback
      let browserAnemic = false;
      try {
        const browserResult = await this.deps.browserFetcher(input.sourceRef, { timeoutMs: 20_000 });
        finalRawHtml = browserResult.rawHtml;
        resolvedFinalUrl = browserResult.finalUrl || resolvedFinalUrl;
        resolvedStatusCode = browserResult.statusCode || resolvedStatusCode;
        escalatedTo = "browser";

        // Anti-bot defense detection: Chromium can be fingerprinted by aggressive
        // anti-bot stacks (Croma, Cloudflare-protected sites, etc.) and served a
        // stub page that's technically a 200 OK but useless. Detect & escalate:
        //   - rawHtml < 5KB AND no structured-data signals → anemic
        //   - explicit anti-bot markers (cf-* selectors, "Access Denied" text) → anemic
        browserAnemic = isAnemicResponse(browserResult.rawHtml);
        if (browserAnemic) {
          escalationReasons.push(`browser_anemic_${browserResult.rawHtml.length}b`);
          throw new Error(`browser returned anemic response (${browserResult.rawHtml.length} bytes)`);
        }
      } catch (browserErr) {
        // Browser failed OR returned anemic content — try unblock vendor.
        if (this.deps.unblockAdapter && withinCostCeiling(costCredits, 5)) {
          try {
            const unblockResult: UnblockResult = await this.deps.unblockAdapter.unblock(input.sourceRef, {
              premiumProxy: true,
              jsRendering: true
            });
            finalRawHtml = unblockResult.rawHtml;
            resolvedFinalUrl = unblockResult.finalUrl || resolvedFinalUrl;
            escalatedTo = "unblock";
            costCredits += unblockResult.costCredits;
          } catch {
            // Both browser and unblock failed.
            // Fallback priority:
            //   1. If browser succeeded (even anemic), keep that HTML — better than nothing.
            //   2. If only static succeeded, keep static.
            //   3. If everything threw, re-throw the original static error.
            if (browserAnemic) {
              escalatedTo = "browser";
              escalationReasons.push("unblock_failed_keeping_anemic_browser");
              // finalRawHtml is already the anemic browser HTML from above.
            } else if (staticResult === null) {
              throw staticFetchError ?? new Error("All fetch tiers failed");
            }
            // Otherwise: keep the static HTML (likely captcha or thin page);
            // downstream parsers yield few facts but the run completes.
          }
        } else if (browserAnemic) {
          // No unblock available but browser was anemic — keep what we have.
          escalatedTo = "browser";
          escalationReasons.push("no_unblock_keeping_anemic_browser");
        } else if (staticResult === null) {
          // No unblock available and static failed — bail.
          throw staticFetchError ?? new Error("Browser fetch failed and unblock not configured");
        }
      }
    }

    // Persist whatever we got. If we forced-browser without static, use what
    // resolved (or the requested URL as fallback for the source_external_id).
    const checksum = staticResult?.contentChecksum ?? sha256Hex(finalRawHtml || input.sourceRef);

    this.cache.set(resolvedFinalUrl, {
      fetchResult: staticResult ?? {
        url: input.sourceRef,
        finalUrl: resolvedFinalUrl,
        statusCode: resolvedStatusCode,
        contentType: resolvedContentType,
        rawHtml: finalRawHtml,
        cleanedText: "",
        structuredBlocks: { jsonLd: [], nextData: null, apolloState: null, initialState: null },
        captchaSignal: false,
        fetchedAt: new Date(),
        contentChecksum: checksum
      },
      finalRawHtml,
      escalatedTo,
      costCredits,
      escalationReasons
    });

    const hints = input.hints;
    yield {
      sourceExternalId: resolvedFinalUrl,
      sourceType: "link_url",
      sourceMarketplace: null,
      rawData: {
        url: input.sourceRef,
        finalUrl: resolvedFinalUrl,
        statusCode: resolvedStatusCode,
        contentType: resolvedContentType,
        fetchedAt: (staticResult?.fetchedAt ?? new Date()).toISOString(),
        htmlSnippet: finalRawHtml.substring(0, 10_000),
        cleanedTextLength: staticResult?.cleanedText.length ?? 0,
        escalatedTo,
        escalationReasons,
        costCredits
      },
      checksum,
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

    // Layer F — vision tier-3 (Phase 9)
    const visionFacts: ExtractedFactSet["facts"] = [];
    const upstreamFacts = [...baseFacts, ...llmFacts];
    const visionDecision = shouldEscalateToVision({
      rawHtml: cached.finalRawHtml,
      hasTextPrice: upstreamFacts.some((f) => f.rawKey === "base_price"),
      upstreamFactCount: upstreamFacts.length
    });
    if (visionDecision.escalate && this.deps.visionExtractor) {
      try {
        const screenshot = await this.deps.screenshotFetcher(cached.fetchResult.finalUrl, {
          timeoutMs: 20_000
        });
        const visionResult = await this.deps.visionExtractor({
          screenshotBase64: screenshot.screenshotBase64,
          pageUrl: cached.fetchResult.finalUrl
        });
        visionFacts.push(...visionResult.facts);
      } catch {
        // Vision failed (screenshot or API error) — don't fail the extract.
      }
    }

    return {
      artifactId: envelope.sourceExternalId as never,
      marketplace: "link_url",
      extractorVersion: LLM_EXTRACTOR_VERSION,
      facts: [...upstreamFacts, ...visionFacts],
      extractedAt: new Date()
    };
  }
}

/**
 * Merge per-site parser facts with generic Layer A/B facts.
 * Per-site wins on rawKey collisions (Layer G is the highest-priority rung
 * for domains where a hand-written parser exists). Generic facts fill gaps.
 */
/**
 * Detect whether a browser-rendered HTML payload is suspiciously empty.
 *
 * Anti-bot vendors (Cloudflare, PerimeterX, Croma's stack, Datadome, etc.)
 * frequently fingerprint headless Chromium via the AutomationControlled flag,
 * navigator.webdriver, missing plugin arrays, and serve a stub page (~hundreds
 * of bytes to a few KB) as a 200 OK. We treat such responses as failures so
 * the LinkAdapter falls through to ScrapingBee (which uses residential proxies
 * + stealth-mode JS rendering specifically to defeat these checks).
 *
 * Heuristics (any one triggers anemic):
 *  - < 5 KB total HTML (a real PDP is usually 50-200 KB)
 *  - no structured-data signals (JSON-LD / __NEXT_DATA__ / __NUXT__)
 *  - explicit anti-bot text markers ("Access Denied", "Just a moment...",
 *    "Verifying you are human", "blocked", "cf-browser-verification")
 */
const ANTI_BOT_MARKERS = [
  /Access\s+Denied/i,
  /Just\s+a\s+moment/i,
  /Verifying\s+you\s+are\s+human/i,
  /cf-browser-verification/i,
  /captcha-delivery/i,
  /unusual\s+traffic/i,
  /<title>Attention Required/i
];

function isAnemicResponse(rawHtml: string): boolean {
  if (!rawHtml || rawHtml.length < 5_000) return true;
  for (const m of ANTI_BOT_MARKERS) {
    if (m.test(rawHtml)) return true;
  }
  // No structured data + no obvious product content
  const hasJsonLd = /application\/ld\+json/i.test(rawHtml);
  const hasNextData = /__NEXT_DATA__/i.test(rawHtml);
  const hasNuxt = /__NUXT__/i.test(rawHtml);
  const hasInitialState = /__INITIAL_STATE__/i.test(rawHtml);
  const hasOgProduct = /og:type"\s+content="product"/i.test(rawHtml);
  if (!hasJsonLd && !hasNextData && !hasNuxt && !hasInitialState && !hasOgProduct) {
    // Also check body length — a real page with no structured data should
    // still have meaningful body content (description, specs, etc.). If the
    // total rawHtml is under 30 KB, that's a strong signal of a stub.
    if (rawHtml.length < 30_000) return true;
  }
  return false;
}

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
