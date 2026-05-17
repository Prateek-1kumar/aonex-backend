import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { PerSiteParser } from "../types.js";
import { registerParser } from "../registry.js";

const CURRENCY_MAP: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };

function extractItemId(url: string): string | null {
  // /itm/<digits> or /itm/<slug>/<digits>
  const match = url.match(/\/itm\/(?:[^/]+\/)?(\d{6,})/);
  return match ? (match[1] ?? null) : null;
}

function makeFact(rawKey: string, value: unknown, source: string, confidence: number): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue: value,
    normalizedValue: null,
    unit: null,
    sourcePointer: source,
    extractionMethod: "direct",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    confidence,
    approved: false,
  };
}

export const ebayParser: PerSiteParser = {
  domains: ["ebay.com", "ebay.co.uk", "ebay.de", "ebay.com.au", "ebay.fr", "ebay.it"],
  priority: 100,
  fingerprint: "ebay@1.0",
  requiresBrowser: false,

  async extract({ rawHtml, url }): Promise<ExtractedFact[]> {
    const $ = cheerio.load(rawHtml);
    const facts: ExtractedFact[] = [];

    const itemId = extractItemId(url);
    if (itemId) facts.push(makeFact("item_id", itemId, "url:/itm/<id>", 1.0));

    const title = $("h1.x-item-title__mainTitle").text().trim();
    if (title) facts.push(makeFact("title", title, "h1.x-item-title__mainTitle", 0.95));

    const priceText =
      $(".x-price-primary span[itemprop='price']").first().text().trim() ||
      $(".x-price-primary .ux-textspans").first().text().trim();
    if (priceText) {
      const num = parseFloat(priceText.replace(/[^\d.]/g, ""));
      if (Number.isFinite(num)) facts.push(makeFact("base_price", num, ".x-price-primary", 0.90));
      const sym = priceText.match(/(\$|€|£|₹|¥)/)?.[1];
      if (sym && CURRENCY_MAP[sym]) facts.push(makeFact("currency", CURRENCY_MAP[sym], "price_symbol", 0.85));
    }

    // Item specifics: pair each labels-content with the sibling values-content
    $(".ux-labels-values").each((_i, el) => {
      const label = $(el).find(".ux-labels-values__labels-content").text().trim();
      const value = $(el).find(".ux-labels-values__values-content").text().trim();
      if (!label || !value) return;
      const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (!key) return;
      facts.push(makeFact(key, value, `.ux-labels-values[${label}]`, 0.80));
    });

    const imageUrls = $(".ux-image-carousel-item img")
      .map((_i, el) => $(el).attr("src"))
      .get()
      .filter((u): u is string => Boolean(u));
    if (imageUrls.length > 0) {
      facts.push(makeFact("images", imageUrls.map((u) => ({ url: u })), ".ux-image-carousel-item img", 0.80));
    }

    return facts;
  },
};

registerParser(ebayParser);
