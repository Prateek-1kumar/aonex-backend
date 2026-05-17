import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { PerSiteParser } from "../types.js";
import { registerParser } from "../registry.js";

function extractAsin(url: string): string | null {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/);
  return match ? (match[1] ?? null) : null;
}

const CURRENCY_MAP: Record<string, string> = {
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  "¥": "JPY",
};

function makeFact(
  rawKey: string,
  value: unknown,
  source: string,
  confidence: number
): ExtractedFact {
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

export const amazonParser: PerSiteParser = {
  domains: [
    "amazon.com",
    "amazon.co.uk",
    "amazon.de",
    "amazon.fr",
    "amazon.in",
    "amazon.co.jp",
    "amazon.ca",
    "amazon.com.au",
  ],
  priority: 100,
  fingerprint: "amazon@1.0",
  requiresBrowser: true,

  async extract({ rawHtml, url }): Promise<ExtractedFact[]> {
    const $ = cheerio.load(rawHtml);
    const facts: ExtractedFact[] = [];

    // ASIN — always extracted from URL, even when HTML is empty
    const asin = extractAsin(url);
    if (asin) {
      facts.push(makeFact("asin", asin, "url:/dp/<asin>", 1.0));
    }

    // Title
    const title = $("#productTitle").text().trim();
    if (title) facts.push(makeFact("title", title, "#productTitle", 0.95));

    // Brand — strip the "Visit the … Store" wrapper text
    let brand = $("#bylineInfo").text().trim();
    brand = brand.replace(/^Visit the\s+/i, "").replace(/\s+Store$/i, "").trim();
    if (brand) facts.push(makeFact("brand", brand, "#bylineInfo", 0.85));

    // Price + currency
    const priceText = $(".a-price .a-offscreen").first().text();
    if (priceText) {
      const num = parseFloat(priceText.replace(/[^\d.]/g, ""));
      if (Number.isFinite(num)) {
        facts.push(makeFact("base_price", num, ".a-price .a-offscreen", 0.92));
      }
      const sym = priceText.match(/(\$|€|£|₹|¥)/)?.[1];
      if (sym && CURRENCY_MAP[sym]) {
        facts.push(makeFact("currency", CURRENCY_MAP[sym], "price_symbol", 0.85));
      }
    }

    // Description — feature bullets joined with newlines
    const bullets = $("#feature-bullets li span")
      .map((_i, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 5);
    if (bullets.length > 0) {
      facts.push(
        makeFact("description", bullets.join("\n"), "#feature-bullets li span", 0.80)
      );
    }

    // Images from alternate image gallery
    const imageUrls = $("#altImages li img")
      .map((_i, el) => $(el).attr("src"))
      .get()
      .filter((u): u is string => Boolean(u));
    if (imageUrls.length > 0) {
      facts.push(
        makeFact(
          "images",
          imageUrls.map((u) => ({ url: u })),
          "#altImages li img",
          0.85
        )
      );
    }

    // Spec table rows (tech spec + detail bullets variants)
    $(
      "#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr"
    ).each((_i, el) => {
      const k = $(el)
        .find("th, .a-text-bold")
        .text()
        .trim()
        .replace(/[^a-z0-9]+/gi, "_")
        .toLowerCase()
        .replace(/^_+|_+$/g, "");
      const v = $(el)
        .find("td, .a-list-item span:last-child")
        .text()
        .trim();
      if (k && v) {
        facts.push(makeFact(k, v, `#productDetails ${k}`, 0.75));
      }
    });

    return facts;
  },
};

registerParser(amazonParser);
