import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.80;

// Match <script type="text/x-magento-init">...</script>
const MAGENTO_RE = /<script[^>]*type=["']text\/x-magento-init["'][^>]*>([\s\S]*?)<\/script>/gi;

export function parseMagento(html: string): ParserOutput {
  const facts: ExtractedFact[] = [];

  for (const m of html.matchAll(MAGENTO_RE)) {
    const jsonText = m[1]!.trim();
    if (!jsonText) continue;

    let config: unknown;
    try {
      config = JSON.parse(jsonText);
    } catch {
      // Malformed block — skip
      continue;
    }

    if (!isRecord(config)) continue;

    // Iterate over selector keys (e.g. "[data-role='priceBox']", "#product-info")
    for (const selectorConfig of Object.values(config)) {
      if (!isRecord(selectorConfig)) continue;

      // Iterate over Magento component keys
      for (const [componentKey, componentConfig] of Object.entries(selectorConfig)) {
        if (!isRecord(componentConfig)) continue;

        if (/Magento_Catalog\/js\/price-box/i.test(componentKey)) {
          extractPriceBox(componentConfig, facts);
        } else if (/Magento_Catalog\/product\/view/i.test(componentKey)) {
          extractProductView(componentConfig, facts);
        }
      }
    }
  }

  return { kind: "magento", facts, baselineConfidence: BASELINE_CONFIDENCE };
}

/**
 * Extract price from priceConfig.prices.finalPrice.amount (or similar paths).
 * Magento price-box configs vary; we try several common shapes.
 */
function extractPriceBox(config: Record<string, unknown>, facts: ExtractedFact[]): void {
  const priceConfig = config["priceConfig"];
  if (!isRecord(priceConfig)) return;

  // Shape: priceConfig.prices.finalPrice.amount
  const prices = priceConfig["prices"];
  if (isRecord(prices)) {
    const finalPrice = prices["finalPrice"];
    if (isRecord(finalPrice) && !alreadyHas(facts, "base_price")) {
      const amount = finalPrice["amount"];
      pushNumber(facts, "base_price", amount, "magento:priceBox.priceConfig.prices.finalPrice.amount");
    }
    // Fallback: regularPrice
    const regularPrice = prices["regularPrice"];
    if (isRecord(regularPrice) && !alreadyHas(facts, "base_price")) {
      const amount = regularPrice["amount"];
      pushNumber(facts, "base_price", amount, "magento:priceBox.priceConfig.prices.regularPrice.amount");
    }
  }

  // Shape: priceConfig.productPrice.amount (older Magento)
  const productPrice = priceConfig["productPrice"];
  if (isRecord(productPrice) && !alreadyHas(facts, "base_price")) {
    pushNumber(facts, "base_price", productPrice["amount"], "magento:priceBox.priceConfig.productPrice.amount");
  }
}

/**
 * Extract product fields from Magento_Catalog/product/view config.
 */
function extractProductView(config: Record<string, unknown>, facts: ExtractedFact[]): void {
  // title: productName | name
  const titleVal = pickFirst(config, ["productName", "name", "title"]);
  pushString(facts, "title", titleVal, "magento:productView.productName");

  // brand
  pushString(facts, "brand", config["brand"], "magento:productView.brand");

  // model_number: sku (Magento SKU is used as MPN)
  const skuVal = pickFirst(config, ["sku", "mpn", "model"]);
  pushString(facts, "model_number", skuVal, "magento:productView.sku");

  // gtin
  pushString(facts, "gtin", config["gtin"], "magento:productView.gtin");

  // description
  pushString(facts, "description", config["description"], "magento:productView.description");

  // price at product/view level (sometimes present)
  const priceVal = pickFirst(config, ["price", "finalPrice"]);
  if (!alreadyHas(facts, "base_price")) {
    pushNumber(facts, "base_price", priceVal, "magento:productView.price");
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function alreadyHas(facts: ExtractedFact[], rawKey: string): boolean {
  return facts.some((f) => f.rawKey === rawKey);
}

function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] != null) return obj[k];
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function makeFact(rawKey: string, extractedValue: unknown, sourcePointer: string): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue,
    normalizedValue: null,
    unit: null,
    sourcePointer,
    extractionMethod: "direct",
    confidence: BASELINE_CONFIDENCE,
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    approved: false,
  };
}

function pushString(
  facts: ExtractedFact[],
  rawKey: string,
  value: unknown,
  sourcePointer: string
): void {
  if (typeof value !== "string" || !value.trim()) return;
  if (alreadyHas(facts, rawKey)) return;
  facts.push(makeFact(rawKey, value, sourcePointer));
}

function pushNumber(
  facts: ExtractedFact[],
  rawKey: string,
  value: unknown,
  sourcePointer: string
): void {
  if (alreadyHas(facts, rawKey)) return;
  if (typeof value === "number" && Number.isFinite(value)) {
    facts.push(makeFact(rawKey, value, sourcePointer));
    return;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) facts.push(makeFact(rawKey, n, sourcePointer));
  }
}
