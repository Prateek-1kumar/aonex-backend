import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { PerSiteParser } from "../types.js";
import { registerParser } from "../registry.js";

const CURRENCY_MAP: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  "¥": "JPY",
};

function extractSku(url: string): string | null {
  // BestBuy: /site/.../<digits>.p
  const match = url.match(/\/site\/[^/]+\/(\d+)\.p/);
  return match ? (match[1] ?? null) : null;
}

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

export const bestbuyParser: PerSiteParser = {
  domains: ["bestbuy.com", "bestbuy.ca"],
  priority: 100,
  fingerprint: "bestbuy@1.0",
  requiresBrowser: true,

  async extract({ rawHtml, url }): Promise<ExtractedFact[]> {
    const $ = cheerio.load(rawHtml);
    const facts: ExtractedFact[] = [];

    // SKU — always extracted from URL, even when HTML is empty
    const sku = extractSku(url);
    if (sku) facts.push(makeFact("sku", sku, "url:/site/.../<sku>.p", 1.0));

    // Title
    const title = $("h1.heading-5, .heading-5.v-fw-regular").first().text().trim();
    if (title) facts.push(makeFact("title", title, ".heading-5.v-fw-regular", 0.92));

    // Price + currency
    const priceText = $(".priceView-customer-price span[aria-hidden='true']").first().text().trim();
    if (priceText) {
      const num = parseFloat(priceText.replace(/[^\d.]/g, ""));
      if (Number.isFinite(num)) {
        facts.push(makeFact("base_price", num, ".priceView-customer-price span[aria-hidden]", 0.90));
      }
      const sym = priceText.match(/(\$|€|£|₹|¥)/)?.[1];
      if (sym && CURRENCY_MAP[sym]) {
        facts.push(makeFact("currency", CURRENCY_MAP[sym], "price_symbol", 0.85));
      }
    }

    // Model number
    const modelNumber = $(".model-number .product-data-value").first().text().trim();
    if (modelNumber) {
      facts.push(makeFact("model_number", modelNumber, ".model-number .product-data-value", 0.88));
    }

    // Spec table rows
    $(".specs-table tbody tr").each((_i, el) => {
      const k = $(el)
        .find(".row-title, th")
        .first()
        .text()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const v = $(el).find(".row-value, td").last().text().trim();
      if (k && v) facts.push(makeFact(k, v, `.specs-table[${k}]`, 0.75));
    });

    // Images from primary wrapper + thumbnails
    const imageUrls = $(".primary-image-wrapper img, .thumbnail-list img")
      .map((_i, el) => $(el).attr("src"))
      .get()
      .filter((u): u is string => Boolean(u));
    if (imageUrls.length > 0) {
      facts.push(
        makeFact(
          "images",
          imageUrls.map((u) => ({ url: u })),
          ".primary-image / .thumbnail-list",
          0.80
        )
      );
    }

    return facts;
  },
};

registerParser(bestbuyParser);
