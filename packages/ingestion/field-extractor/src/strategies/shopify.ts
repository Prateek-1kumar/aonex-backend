// HLD §9 — Shopify field extractor strategy.
// EXTRACTOR_VERSION = 'shopify@1.0.0' — bump when extraction logic changes
// so extraction_runs UNIQUE key detects stale runs and replays them.
//
// Raw data shape is the ShopifyProduct record produced by
// apps/nango/syncs/shopify/products.ts (stripped of _nango_metadata).

import type { ArtifactId } from "@aonex/types";
import type { ArtifactExtractor, ExtractedFact, ExtractedFactSet } from "../types.js";

export const EXTRACTOR_VERSION = "shopify@1.0.0";

interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  inventoryQuantity: number;
  selectedOptions: Array<{ name: string; value: string }>;
}

interface ShopifyImage {
  url: string;
  altText: string | null;
}

interface ShopifyOption {
  name: string;
  values: string[];
}

function fact(
  rawKey: string,
  extractedValue: unknown,
  normalizedValue: unknown,
  sourcePointer: string,
  extractionMethod: ExtractedFact["extractionMethod"],
  confidence: number,
  unit: string | null = null
): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue,
    normalizedValue,
    unit,
    sourcePointer,
    extractionMethod,
    confidence,
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    approved: false
  };
}

function normalizeString(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v).trim();
}

function normalizePrice(v: unknown): number | null {
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

function extract(rawData: Record<string, unknown>, artifactId: ArtifactId): ExtractedFactSet {
  const facts: ExtractedFact[] = [];

  // --- Product-level fields ---
  const title = normalizeString(rawData["title"]);
  if (title !== null) {
    facts.push(fact("title", rawData["title"], title, "$.title", "direct", 1.0));
  }

  const vendor = normalizeString(rawData["vendor"]);
  if (vendor !== null) {
    facts.push(fact("vendor", rawData["vendor"], vendor, "$.vendor", "direct", 0.95));
  }

  const productType = normalizeString(rawData["productType"]);
  if (productType !== null) {
    facts.push(
      fact("productType", rawData["productType"], productType, "$.productType", "direct", 0.85)
    );
  }

  const status = normalizeString(rawData["status"]);
  if (status !== null) {
    facts.push(
      fact("status", rawData["status"], status.toLowerCase(), "$.status", "direct", 1.0)
    );
  }

  const tags = rawData["tags"];
  if (Array.isArray(tags) && tags.length > 0) {
    facts.push(fact("tags", tags, tags, "$.tags", "direct", 0.90));
  }

  const images = rawData["images"];
  if (Array.isArray(images) && images.length > 0) {
    const normalizedImages = (images as ShopifyImage[]).map((img) => ({
      url: img.url,
      altText: img.altText ?? null
    }));
    facts.push(fact("images", images, normalizedImages, "$.images", "direct", 1.0));
  }

  // --- Variant-level aggregations ---
  const variants = rawData["variants"] as ShopifyVariant[] | undefined;
  if (Array.isArray(variants) && variants.length > 0) {
    // base_price: lowest variant price (computed)
    const prices = variants
      .map((v, i) => ({ price: normalizePrice(v.price), index: i }))
      .filter((p) => p.price !== null);

    if (prices.length > 0) {
      const minEntry = prices.reduce((a, b) => (a.price! < b.price! ? a : b));
      facts.push(
        fact(
          "base_price",
          rawData["variants"],
          minEntry.price,
          `$.variants[${minEntry.index}].price`,
          "computed",
          0.95,
          "currency" // unit resolved from currency field in catalog service
        )
      );
    }

    // gtin: first non-empty barcode across variants
    const gtinEntry = variants.find((v) => v.barcode && v.barcode.trim() !== "");
    if (gtinEntry) {
      const idx = variants.indexOf(gtinEntry);
      facts.push(
        fact(
          "gtin",
          gtinEntry.barcode,
          gtinEntry.barcode!.trim(),
          `$.variants[${idx}].barcode`,
          "direct",
          0.90
        )
      );
    }

    // model_number: first non-empty SKU across variants (inferred — SKU ≠ model# always)
    const skuEntry = variants.find((v) => v.sku && v.sku.trim() !== "");
    if (skuEntry) {
      const idx = variants.indexOf(skuEntry);
      facts.push(
        fact(
          "model_number",
          skuEntry.sku,
          skuEntry.sku!.trim(),
          `$.variants[${idx}].sku`,
          "inferred",
          0.70
        )
      );
    }

    // Per-variant facts (for variant extractor to consume)
    variants.forEach((v, i) => {
      if (v.sku) {
        facts.push(
          fact(`variants[${i}].sku`, v.sku, v.sku.trim(), `$.variants[${i}].sku`, "direct", 0.95)
        );
      }
      if (v.barcode) {
        facts.push(
          fact(
            `variants[${i}].barcode`,
            v.barcode,
            v.barcode.trim(),
            `$.variants[${i}].barcode`,
            "direct",
            0.90
          )
        );
      }
      const variantPrice = normalizePrice(v.price);
      if (variantPrice !== null) {
        facts.push(
          fact(
            `variants[${i}].price`,
            v.price,
            variantPrice,
            `$.variants[${i}].price`,
            "direct",
            0.95
          )
        );
      }
      // selectedOptions: each option as a separate fact
      v.selectedOptions.forEach((opt, j) => {
        facts.push(
          fact(
            `variants[${i}].option.${opt.name}`,
            opt.value,
            opt.value,
            `$.variants[${i}].selectedOptions[${j}].value`,
            "direct",
            0.95
          )
        );
      });
    });
  }

  // options (variant axes definition at product level)
  const options = rawData["options"] as ShopifyOption[] | undefined;
  if (Array.isArray(options) && options.length > 0) {
    facts.push(fact("options", options, options, "$.options", "direct", 1.0));
  }

  return {
    artifactId,
    marketplace: "shopify",
    extractorVersion: EXTRACTOR_VERSION,
    facts,
    extractedAt: new Date()
  };
}

export const shopifyExtractor: ArtifactExtractor = {
  version: EXTRACTOR_VERSION,
  extract
};
