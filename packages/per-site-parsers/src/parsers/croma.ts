import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { PerSiteParser } from "../types.js";
import { registerParser } from "../registry.js";

const CURRENCY_MAP: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };

function extractSku(url: string): string | null {
  // Croma: /<slug>/p/<sku> where sku is alphanumeric (typically digits)
  const match = url.match(/\/p\/([a-z0-9-]+)/i);
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

function parseJsonLdProduct(rawHtml: string): Record<string, unknown> | null {
  // Find all <script type="application/ld+json"> blocks and pick one with @type=Product
  const blocks = rawHtml.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of blocks) {
    try {
      const parsed = JSON.parse(m[1]!);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        if (c && typeof c === "object" && c["@type"] === "Product") {
          return c as Record<string, unknown>;
        }
      }
    } catch {
      // ignore malformed
    }
  }
  return null;
}

export const cromaParser: PerSiteParser = {
  domains: ["croma.com"],
  priority: 100,
  fingerprint: "croma@1.0",
  requiresBrowser: false,

  async extract({ rawHtml, url }): Promise<ExtractedFact[]> {
    const facts: ExtractedFact[] = [];

    const sku = extractSku(url);
    if (sku) facts.push(makeFact("sku", sku, "url:/p/<sku>", 1.0));

    // JSON-LD path (preferred)
    const ld = parseJsonLdProduct(rawHtml);
    if (ld) {
      if (typeof ld.name === "string") facts.push(makeFact("title", ld.name, "json_ld.name", 0.95));
      const brand =
        typeof ld.brand === "object" && ld.brand !== null
          ? ((ld.brand as Record<string, unknown>).name as string | undefined)
          : typeof ld.brand === "string"
            ? ld.brand
            : undefined;
      if (brand) facts.push(makeFact("brand", brand, "json_ld.brand", 0.90));
      const gtin = (ld.gtin13 ?? ld.gtin ?? ld.gtin8 ?? ld.gtin12 ?? ld.gtin14) as string | number | undefined;
      if (gtin) facts.push(makeFact("gtin", String(gtin), "json_ld.gtin", 0.95));
      const offers = ld.offers as Record<string, unknown> | undefined;
      if (offers) {
        const priceVal =
          offers.price ??
          (offers.priceSpecification as Record<string, unknown> | undefined)?.price;
        if (priceVal != null) {
          const priceNum = typeof priceVal === "number" ? priceVal : parseFloat(String(priceVal));
          if (Number.isFinite(priceNum)) facts.push(makeFact("base_price", priceNum, "json_ld.offers.price", 0.93));
        }
        const currencyVal = (
          offers.priceCurrency ??
          (offers.priceSpecification as Record<string, unknown> | undefined)?.priceCurrency
        ) as string | undefined;
        if (currencyVal) facts.push(makeFact("currency", currencyVal, "json_ld.offers.priceCurrency", 0.93));
      }
    }

    const seen = new Set(facts.map((f) => f.rawKey));
    const $ = cheerio.load(rawHtml);

    // DOM fallbacks
    if (!seen.has("title")) {
      const t = $("h1.pd-title, h1.product-title").first().text().trim();
      if (t) facts.push(makeFact("title", t, "h1.pd-title", 0.88));
    }
    if (!seen.has("brand")) {
      const b = $(".brand-name").first().text().trim();
      if (b) facts.push(makeFact("brand", b, ".brand-name", 0.85));
    }
    if (!seen.has("base_price")) {
      const priceText = $(".new-price, .product-price .amount, .product-price").first().text().trim();
      if (priceText) {
        const num = parseFloat(priceText.replace(/[^\d.]/g, ""));
        if (Number.isFinite(num)) facts.push(makeFact("base_price", num, ".new-price", 0.82));
        const sym = priceText.match(/(\$|€|£|₹|¥)/)?.[1];
        if (sym && CURRENCY_MAP[sym] && !seen.has("currency")) {
          facts.push(makeFact("currency", CURRENCY_MAP[sym]!, "price_symbol", 0.80));
        }
      }
    }

    // Spec list (additive — runs regardless)
    $(".pdp-specifications-list .specification-item").each((_i, el) => {
      const label = $(el).find(".spec-label").text().trim();
      const value = $(el).find(".spec-value").text().trim();
      if (!label || !value) return;
      const key = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      if (!key) return;
      facts.push(makeFact(key, value, `croma-spec[${label}]`, 0.75));
    });

    // Images
    const imageUrls = $(".product-image img, .image-gallery img")
      .map((_i, el) => $(el).attr("src"))
      .get()
      .filter((u): u is string => Boolean(u));
    if (imageUrls.length > 0) {
      facts.push(makeFact("images", imageUrls.map((u) => ({ url: u })), ".product-image img", 0.80));
    }

    return facts;
  },
};

registerParser(cromaParser);
