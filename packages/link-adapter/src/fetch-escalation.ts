import type { LinkFetchResult } from "@aonex/ingestion-link-fetcher";
import { type fetchLink } from "@aonex/ingestion-link-fetcher";
import {
  fetchWithBrowser,
  shouldEscalateToBrowser,
  type FetchBrowserResult
} from "@aonex/ingestion-browser-fallback";
import { withinCostCeiling, type UnblockResult } from "@aonex/ingestion-antibot-vendor";
import type { PerSiteParser } from "@aonex/per-site-parsers";
import { sha256Hex } from "@aonex/lib-utils";
import type { EscalatedTo, BrowserFetcher, UnblockAdapter } from "./link-adapter.js";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";

// Re-export FetchBrowserResult so it is available to consumers of this module
// without requiring a direct dependency on ingestion-browser-fallback.
export type { FetchBrowserResult };

export interface CacheEntry {
  fetchResult: LinkFetchResult;
  finalRawHtml: string;
  escalatedTo: EscalatedTo;
  costCredits: number;
  escalationReasons: string[];
}

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
export const ANTI_BOT_MARKERS = [
  /Access\s+Denied/i,
  /Just\s+a\s+moment/i,
  /Verifying\s+you\s+are\s+human/i,
  /cf-browser-verification/i,
  /captcha-delivery/i,
  /unusual\s+traffic/i,
  /<title>Attention Required/i
];

export function isAnemicResponse(rawHtml: string): boolean {
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

export async function runFetchEscalation(
  deps: {
    fetcher: typeof fetchLink;
    browserFetcher: BrowserFetcher;
    unblockAdapter: UnblockAdapter | null;
    findPerSiteParser: (url: string) => PerSiteParser | null;
  },
  input: { sourceRef: string; hints?: { categoryHint?: string; localeHint?: string } }
): Promise<{ cacheEntry: CacheEntry; envelope: IngestionEnvelope }> {
  // Per-site parser short-circuit: if a registered parser declares
  // `requiresBrowser: true` for this hostname (Amazon, Walmart, BestBuy),
  // skip the static fetch entirely and go straight to browser. Avoids
  // wasted requests to known-aggressively-bot-walled retailers.
  const perSiteParser = deps.findPerSiteParser(input.sourceRef);
  const forceBrowser = perSiteParser?.requiresBrowser === true;

  let staticResult: LinkFetchResult | null = null;
  let staticFetchError: unknown = null;
  if (!forceBrowser) {
    try {
      staticResult = await deps.fetcher(input.sourceRef);
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
  const resolvedContentType = staticResult?.contentType ?? "text/html";

  if (mustEscalate) {
    // Layer C — browser fallback
    let browserAnemic = false;
    try {
      const browserResult = await deps.browserFetcher(input.sourceRef, { timeoutMs: 20_000 });
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
    } catch {
      // Browser failed OR returned anemic content — try unblock vendor.
      if (deps.unblockAdapter && withinCostCeiling(costCredits, 5)) {
        try {
          const unblockResult: UnblockResult = await deps.unblockAdapter.unblock(input.sourceRef, {
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

  const cacheEntry: CacheEntry = {
    fetchResult: staticResult ?? {
      url: input.sourceRef,
      finalUrl: resolvedFinalUrl,
      statusCode: resolvedStatusCode,
      contentType: resolvedContentType,
      rawHtml: finalRawHtml,
      cleanedText: "",
      structuredBlocks: { jsonLd: [], nextData: null, apolloState: null, initialState: null, metaTags: {}, linkTags: {}, microdata: [], images: [], breadcrumbs: [] },
      captchaSignal: false,
      fetchedAt: new Date(),
      contentChecksum: checksum
    },
    finalRawHtml,
    escalatedTo,
    costCredits,
    escalationReasons
  };

  const hints = input.hints;
  const envelope: IngestionEnvelope = {
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

  return { cacheEntry, envelope };
}

// Satisfy the unused import — fetchWithBrowser is referenced in the type
// signature for BrowserFetcher's default value (the class sets it as default).
// This export just ensures the symbol is referenced and tree-shaken cleanly.
export { fetchWithBrowser };
