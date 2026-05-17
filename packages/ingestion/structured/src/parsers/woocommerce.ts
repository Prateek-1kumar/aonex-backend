import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.75;

// WooCommerce pages include these classes on <body>
const WOO_BODY_CLASS_RE = /\bsingle-product\b/i;

// Detect the .product div with data-product_id or data-product_sku
const PRODUCT_DIV_RE =
  /<div[^>]+class=["'][^"']*\bproduct\b[^"']*["'][^>]*>/i;

// Extract data-product_sku from the product div
const PRODUCT_SKU_RE = /data-product_sku=["']([^"']+)["']/i;

// Extract data-product_id
const PRODUCT_ID_RE = /data-product_id=["']([^"']+)["']/i;

// Extract title from <h1 class="product_title">
const PRODUCT_TITLE_RE =
  /<h1[^>]+class=["'][^"']*\bproduct_title\b[^"']*["'][^>]*>\s*([^<]+)/i;

// Extract price from <span class="woocommerce-Price-amount">$199.99</span>
// or from <bdi> inside it
const PRICE_RE =
  /<span[^>]+class=["'][^"']*\bwoocommerce-Price-amount\b[^"']*["'][^>]*>([^<]*(?:<[^>]*>[^<]*<\/[^>]*>)*[^<]*)<\/span>/i;

// Strip HTML tags and currency symbols to extract a numeric price
const STRIP_TAGS_RE = /<[^>]+>/g;
const CURRENCY_RE = /[^\d.,\s]/g;

export function parseWoocommerce(html: string): ParserOutput {
  // Guard: must look like a WooCommerce single-product page
  const bodyClassM = html.match(/<body[^>]+class=["']([^"']*)["'][^>]*>/i);
  const bodyClass = bodyClassM?.[1] ?? "";
  if (!WOO_BODY_CLASS_RE.test(bodyClass)) {
    return { kind: "woocommerce", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  const facts: ExtractedFact[] = [];

  // Title
  const titleM = html.match(PRODUCT_TITLE_RE);
  if (titleM) {
    const title = titleM[1]!.trim();
    if (title) {
      facts.push(makeFact("title", title, "woocommerce:product_title"));
    }
  }

  // Price — strip HTML tags then parse numeric value
  const priceM = html.match(PRICE_RE);
  if (priceM) {
    const rawPriceHtml = priceM[1]!;
    const rawPriceText = rawPriceHtml.replace(STRIP_TAGS_RE, "").trim();
    // Remove currency symbols and thousands separators (keep digits, dot, comma)
    const priceStr = rawPriceText.replace(CURRENCY_RE, "").replace(/,/g, "");
    const price = Number(priceStr);
    if (Number.isFinite(price) && price > 0) {
      facts.push(makeFact("base_price", price, "woocommerce:woocommerce-Price-amount"));
    }
  }

  // Product div for data-product_sku and data-product_id
  const productDivM = html.match(PRODUCT_DIV_RE);
  if (productDivM) {
    const divTag = productDivM[0]!;

    // model_number from data-product_sku (WooCommerce SKU often doubles as MPN)
    const skuM = divTag.match(PRODUCT_SKU_RE);
    if (skuM && skuM[1]!.trim()) {
      facts.push(makeFact("model_number", skuM[1]!.trim(), "woocommerce:product.data-product_sku"));
    }

    // sku from data-product_id (internal WooCommerce ID)
    const idM = divTag.match(PRODUCT_ID_RE);
    if (idM && idM[1]!.trim()) {
      facts.push(makeFact("sku", idM[1]!.trim(), "woocommerce:product.data-product_id"));
    }
  }

  return { kind: "woocommerce", facts, baselineConfidence: BASELINE_CONFIDENCE };
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
