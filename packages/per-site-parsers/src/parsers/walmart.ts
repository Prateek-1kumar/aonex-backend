import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { PerSiteParser } from "../types.js";
import { registerParser } from "../registry.js";

const CURRENCY_MAP: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };
const NEXT_DATA_PATTERN = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

function extractProductId(url: string): string | null {
  const match = url.match(/\/ip\/[^/]+\/(\d+)/);
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

function tryParseNextData(rawHtml: string): Record<string, unknown> | null {
  const m = rawHtml.match(NEXT_DATA_PATTERN);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickProduct(payload: Record<string, unknown>): Record<string, unknown> | null {
  // payload.props.pageProps.initialData.data.product
  const path = ["props", "pageProps", "initialData", "data", "product"];
  let node: unknown = payload;
  for (const key of path) {
    if (typeof node !== "object" || node === null || !(key in (node as Record<string, unknown>))) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "object" && node !== null ? (node as Record<string, unknown>) : null;
}

export const walmartParser: PerSiteParser = {
  domains: ["walmart.com"],
  priority: 100,
  fingerprint: "walmart@1.0",
  requiresBrowser: true,

  async extract({ rawHtml, url }): Promise<ExtractedFact[]> {
    const facts: ExtractedFact[] = [];

    const productId = extractProductId(url);
    if (productId) facts.push(makeFact("product_id", productId, "url:/ip/<slug>/<id>", 1.0));

    // Prefer __NEXT_DATA__
    const nextData = tryParseNextData(rawHtml);
    const product = nextData ? pickProduct(nextData) : null;

    if (product) {
      if (typeof product.name === "string") facts.push(makeFact("title", product.name, "__NEXT_DATA__.product.name", 0.95));
      const brand =
        typeof product.brand === "object" && product.brand !== null
          ? ((product.brand as Record<string, unknown>).name as string | undefined)
          : typeof product.brand === "string"
          ? product.brand
          : undefined;
      if (brand) facts.push(makeFact("brand", brand, "__NEXT_DATA__.product.brand", 0.90));
      const priceNode = product.price as Record<string, unknown> | undefined;
      if (priceNode && typeof priceNode.price === "number") {
        facts.push(makeFact("base_price", priceNode.price, "__NEXT_DATA__.product.price.price", 0.93));
      }
      if (priceNode && typeof priceNode.currencyUnit === "string") {
        facts.push(makeFact("currency", priceNode.currencyUnit, "__NEXT_DATA__.product.price.currencyUnit", 0.93));
      }
      if (typeof product.gtin === "string") facts.push(makeFact("gtin", product.gtin, "__NEXT_DATA__.product.gtin", 0.95));
      if (typeof product.model === "string") facts.push(makeFact("model_number", product.model, "__NEXT_DATA__.product.model", 0.90));
    }

    // DOM fallbacks (only fire if NEXT_DATA didn't supply the field)
    const $ = cheerio.load(rawHtml);
    const seen = new Set(facts.map((f) => f.rawKey));

    if (!seen.has("title")) {
      const t = $("h1[itemprop='name']").text().trim();
      if (t) facts.push(makeFact("title", t, "h1[itemprop=name]", 0.85));
    }
    if (!seen.has("base_price")) {
      const priceText = $("[data-automation-id='product-price']").first().text().trim();
      if (priceText) {
        const num = parseFloat(priceText.replace(/[^\d.]/g, ""));
        if (Number.isFinite(num)) facts.push(makeFact("base_price", num, "[data-automation-id=product-price]", 0.80));
        const sym = priceText.match(/(\$|€|£|₹|¥)/)?.[1];
        if (sym && CURRENCY_MAP[sym] && !seen.has("currency")) facts.push(makeFact("currency", CURRENCY_MAP[sym], "price_symbol", 0.75));
      }
    }

    // Specs (always run — additive)
    $("[data-testid='product-specifications'] table tr").each((_i, el) => {
      const k = $(el)
        .find("td")
        .first()
        .text()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const v = $(el).find("td").last().text().trim();
      if (k && v && k !== v.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")) {
        facts.push(makeFact(k, v, `walmart-spec[${k}]`, 0.75));
      }
    });

    return facts;
  },
};

registerParser(walmartParser);
