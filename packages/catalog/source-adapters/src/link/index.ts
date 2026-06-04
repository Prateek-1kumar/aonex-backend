// Link source adapter — maps an extracted product-link SkuJson into observations.
//
// Exports linkAdapter (sourceKind "link"), which turns the link-extraction
// pipeline's SkuJson (wrapped in a LinkAdapterInput envelope with sourceUrl /
// observedAt / artifactId) into parent + variant observations, pricing, inventory,
// and an IdentityHint. Also exports channelCodeFromUrl(), used by the worker's
// link-extract processor to resolve the channel. Registered via the package's src/index.ts.

import type { SkuJson, SkuVariant, SkuImage } from "@aonex/ingestion-enrichment";
import type { ArtifactId } from "@aonex/types";
import type {
  SourceAdapter,
  AdapterOutput,
  AdaptContext,
  CanonicalObservation,
  PricingObservation,
  InventoryObservation,
  IdentityHint,
} from "../types.js";

/**
 * Envelope shape consumed by the link adapter.
 *
 * Why this is not just SkuJson: the link extractor's SkuJson does not carry
 * `source_url`, `observed_at`, or `artifact_id`. The adapter requires those
 * so it can derive a channel code and stamp observations with a real timestamp.
 * Callers (the orchestrator / ingestion pipeline) wrap a SkuJson in this
 * envelope before invoking the adapter — keeping SkuJson coupling-free.
 */
export interface LinkAdapterInput {
  sku: SkuJson;
  sourceUrl: string;
  observedAt: string | Date;
  artifactId?: ArtifactId;
}

/**
 * Channel-code derivation from a product source URL.
 *
 * Public API: re-exported from `@aonex/catalog-source-adapters/index.ts`
 * and consumed by the worker's link-extract processor (Task 4.2) to look
 * up the matching channel row. Output format is part of the contract —
 * changing it requires updating the channel-resolver alongside.
 *
 * - flipkart.com   → "flipkart"
 * - amazon.<tld>   → "amazon-<tld-dot-replaced>"   (e.g. amazon.com.au → amazon-com-au)
 * - ebay.<tld>     → "ebay-<tld-dot-replaced>"
 * - other          → host with all dots replaced by hyphens (myshop.example.io → myshop-example-io)
 *
 * Strips leading "www.".
 */
export function channelCodeFromUrl(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (host.includes("flipkart.com")) return "flipkart";
  if (host.startsWith("amazon.")) {
    const tld = host.slice("amazon.".length);
    return `amazon-${tld.replace(/\./g, "-")}`;
  }
  if (host.startsWith("ebay.")) {
    const tld = host.slice("ebay.".length);
    return `ebay-${tld.replace(/\./g, "-")}`;
  }
  return host.replace(/\./g, "-");
}

/**
 * Map variant.availability strings → integer qty estimates for InventoryObservation.
 *
 * SkuVariant does not (currently) have an `availability` field — but the
 * adapter is forward-compatible: if a variant has an `availability` string,
 * we translate as below. Document keeps the mapping in one place.
 *
 *   "in_stock"     → 999  (sentinel "definitely available, exact count unknown")
 *   "low_stock"    → 1    (signals scarcity)
 *   "out_of_stock" → 0
 *   anything else  → undefined (no observation emitted)
 */
function availabilityToQty(availability: string | null | undefined): number | undefined {
  switch (availability) {
    case "in_stock":
      return 999;
    case "low_stock":
      return 1;
    case "out_of_stock":
      return 0;
    case null:
    case undefined:
    default:
      return undefined;
  }
}

/** Default confidence when neither field-specific nor category confidence applies. */
const DEFAULT_CONFIDENCE = 0.85;

function pickConfidence(sku: SkuJson, field: string, fallback = DEFAULT_CONFIDENCE): number {
  const conf = sku._field_confidence[field];
  return typeof conf === "number" ? conf : fallback;
}

function adapt(input: unknown, ctx: AdaptContext): AdapterOutput {
  const envelope = input as LinkAdapterInput;
  if (!envelope || !envelope.sku || !envelope.sourceUrl) {
    throw new Error(
      "linkAdapter: expected LinkAdapterInput { sku, sourceUrl, observedAt }",
    );
  }
  const sku = envelope.sku;
  const channelCode = channelCodeFromUrl(envelope.sourceUrl);
  const locale = ctx.channelDefaultLocale ?? "_unscoped";
  const source = `${channelCode}:link`;
  /**
   * sourceRecordId fallback order:
   *   1. sku.sku       (marketplace's per-listing id — most specific)
   *   2. sku.gtin      (global product id — works when listing id is missing)
   *   3. sourceUrl     (always present; last resort)
   */
  const recordId: string = sku.sku ?? sku.gtin ?? envelope.sourceUrl;
  const observedAt =
    envelope.observedAt instanceof Date
      ? envelope.observedAt
      : new Date(envelope.observedAt);

  const observations: CanonicalObservation[] = [];
  const pricing: PricingObservation[] = [];
  const inventory: InventoryObservation[] = [];

  // --- Parent-level observations ------------------------------------------------

  if (sku.title !== null) {
    observations.push({
      attributeCode: "title",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.title,
      confidence: pickConfidence(sku, "title"),
      observedAt,
    });
  }

  if (sku.brand !== null) {
    // brand lives at "_unscoped" channel + locale — it's an identity attribute
    // that shouldn't be scoped per marketplace.
    observations.push({
      attributeCode: "brand",
      target: "parent",
      channelCode: "_unscoped",
      localeCode: "_unscoped",
      source,
      sourceRecordId: recordId,
      value: sku.brand,
      confidence: pickConfidence(sku, "brand", 0.9),
      observedAt,
    });
  }

  if (sku.model_number !== null) {
    observations.push({
      attributeCode: "model_number",
      target: "parent",
      channelCode: "_unscoped",
      localeCode: "_unscoped",
      source,
      sourceRecordId: recordId,
      value: sku.model_number,
      confidence: pickConfidence(sku, "model_number"),
      observedAt,
    });
  }

  // Identity attributes at parent (when no variants exist or for non-variant identity).
  if (sku.gtin !== null) {
    observations.push({
      attributeCode: "identity.gtin",
      target: "parent",
      channelCode: "_unscoped",
      localeCode: "_unscoped",
      source,
      sourceRecordId: recordId,
      value: sku.gtin,
      confidence: pickConfidence(sku, "gtin", 0.9),
      observedAt,
    });
  }
  if (sku.mpn !== null) {
    observations.push({
      attributeCode: "identity.mpn",
      target: "parent",
      channelCode: "_unscoped",
      localeCode: "_unscoped",
      source,
      sourceRecordId: recordId,
      value: sku.mpn,
      confidence: pickConfidence(sku, "mpn"),
      observedAt,
    });
  }
  if (sku.sku !== null) {
    observations.push({
      attributeCode: "identity.sku",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.sku,
      confidence: pickConfidence(sku, "sku"),
      observedAt,
    });
  }

  if (sku.description_short !== null) {
    observations.push({
      attributeCode: "description_short",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.description_short,
      confidence: pickConfidence(sku, "description_short"),
      observedAt,
    });
  }
  if (sku.description_long !== null) {
    observations.push({
      attributeCode: "description_long",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.description_long,
      confidence: pickConfidence(sku, "description_long"),
      observedAt,
    });
  }

  if (sku.highlights.length > 0) {
    observations.push({
      attributeCode: "highlights",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.highlights,
      confidence: pickConfidence(sku, "highlights"),
      observedAt,
    });
  }

  if (sku.category_path !== null) {
    observations.push({
      attributeCode: "category_path",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.category_path,
      // Confidence picked from category_confidence (the category-specific score).
      confidence: sku.category_confidence,
      observedAt,
      // breadcrumbs is the structured form of the same data; keep it as extras
      // so nothing is silently dropped.
      extras: { breadcrumbs: sku.breadcrumbs },
    });
  }

  // ratings (object) preserved as a single observation.
  if (sku.ratings.average !== null || sku.ratings.count !== null) {
    observations.push({
      attributeCode: "ratings",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.ratings,
      confidence: pickConfidence(sku, "ratings"),
      observedAt,
    });
  }

  // seller (per-channel concept; bind to channel)
  if (sku.seller.name !== null || sku.seller.is_official !== null) {
    observations.push({
      attributeCode: "seller",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.seller,
      confidence: pickConfidence(sku, "seller"),
      observedAt,
    });
  }

  // images preserved as one observation; consumers can decompose downstream.
  if (sku.images.length > 0) {
    observations.push({
      attributeCode: "images",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.images,
      confidence: pickConfidence(sku, "images"),
      observedAt,
    });
  }

  // shipping (per-channel)
  if (
    sku.shipping.free_shipping !== null ||
    sku.shipping.shipping_cost !== null ||
    sku.shipping.weight !== null ||
    sku.shipping.dimensions !== null
  ) {
    observations.push({
      attributeCode: "shipping",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.shipping,
      confidence: pickConfidence(sku, "shipping"),
      observedAt,
    });
  }

  if (sku.warranty !== null) {
    observations.push({
      attributeCode: "warranty",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.warranty,
      confidence: pickConfidence(sku, "warranty"),
      observedAt,
    });
  }
  if (sku.return_policy !== null) {
    observations.push({
      attributeCode: "return_policy",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.return_policy,
      confidence: pickConfidence(sku, "return_policy"),
      observedAt,
    });
  }

  // options (variant-axis declarations) preserved at parent.
  if (sku.options.length > 0) {
    observations.push({
      attributeCode: "options",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: sku.options,
      confidence: pickConfidence(sku, "options"),
      observedAt,
    });
  }

  // sku.attributes map → one observation per attribute_code.
  for (const [attrCode, attrEntry] of Object.entries(sku.attributes)) {
    observations.push({
      attributeCode: attrCode,
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: recordId,
      value: attrEntry.value,
      confidence: pickConfidence(sku, attrCode),
      observedAt,
      // unit + source-tag preserved so downstream reconciliation isn't
      // forced to re-derive them; the canonical reconciler may use these.
      extras: {
        unit: attrEntry.unit,
        sourceTag: attrEntry.source,
      },
    });
  }

  // --- Pricing (parent-level) ---------------------------------------------------

  const parentPricing = buildPricingObservation(
    sku.pricing,
    {
      productHint: sku.gtin ?? sku.sku ?? sku.title ?? envelope.sourceUrl,
      channelCode,
      locale,
      source,
      sourceRecordId: recordId,
      observedAt,
      ...(envelope.artifactId !== undefined ? { artifactId: envelope.artifactId } : {}),
    },
    ctx,
  );
  if (parentPricing) pricing.push(parentPricing);

  // --- Variants -----------------------------------------------------------------

  for (const variant of sku.variants) {
    const variantAxes = variant.option_values;
    const variantRecordId = variant.sku ?? variant.barcode ?? recordId;

    // Identity observations per variant
    if (variant.sku !== null) {
      observations.push({
        attributeCode: "identity.sku",
        target: "variant",
        variantAxes,
        channelCode,
        localeCode: locale,
        source,
        sourceRecordId: variantRecordId,
        value: variant.sku,
        confidence: DEFAULT_CONFIDENCE,
        observedAt,
      });
    }
    if (variant.barcode !== null) {
      observations.push({
        attributeCode: "identity.gtin",
        target: "variant",
        variantAxes,
        channelCode: "_unscoped",
        localeCode: "_unscoped",
        source,
        sourceRecordId: variantRecordId,
        value: variant.barcode,
        confidence: 0.9,
        observedAt,
      });
    }

    // Variant image observations (one obs holding the array, parallel to parent).
    if (variant.image_urls.length > 0) {
      observations.push({
        attributeCode: "images",
        target: "variant",
        variantAxes,
        channelCode,
        localeCode: locale,
        source,
        sourceRecordId: variantRecordId,
        value: variant.image_urls,
        confidence: DEFAULT_CONFIDENCE,
        observedAt,
      });
    }

    // Per-variant pricing observation
    const variantPricing = buildPricingObservation(
      variant.pricing,
      {
        productHint: variant.sku ?? variant.barcode ?? sku.title ?? envelope.sourceUrl,
        variantAxes,
        channelCode,
        locale,
        source,
        sourceRecordId: variantRecordId,
        observedAt,
        ...(envelope.artifactId !== undefined ? { artifactId: envelope.artifactId } : {}),
      },
      ctx,
    );
    if (variantPricing) pricing.push(variantPricing);

    // Forward-compatible: if a variant exposes `availability` (not in current
    // SkuVariant type but tolerated as extra field), emit an InventoryObservation.
    // See availabilityToQty() for the mapping.
    const availability = (variant as unknown as { availability?: string | null })
      .availability;
    const qty = availabilityToQty(availability);
    if (qty !== undefined) {
      inventory.push({
        productHint: variant.sku ?? variant.barcode ?? sku.title ?? envelope.sourceUrl,
        variantAxes,
        channelCode,
        qty,
        source,
        sourceRecordId: variantRecordId,
        observedAt,
        ...(envelope.artifactId !== undefined ? { artifactId: envelope.artifactId } : {}),
      });
    }
  }

  // --- Identity hint ------------------------------------------------------------

  const identityHint: IdentityHint = {
    ...(sku.gtin !== null ? { gtin: sku.gtin } : {}),
    ...(sku.mpn !== null ? { mpn: sku.mpn } : {}),
    ...(sku.brand !== null ? { brand: sku.brand } : {}),
    ...(sku.title !== null ? { titleForFuzzy: sku.title } : {}),
    targetIsVariant: sku.variants.length > 0,
  };

  return {
    observations,
    pricingObservations: pricing,
    inventoryObservations: inventory,
    identityHint,
    rawPayload: sku,
  };
}

interface PricingContext {
  productHint: string;
  variantAxes?: Record<string, string>;
  channelCode: string;
  locale: string;
  source: string;
  sourceRecordId: string;
  observedAt: Date;
  artifactId?: ArtifactId;
}

function buildPricingObservation(
  pricingInput: { list_price: number | null; sale_price: number | null; currency: string | null },
  pctx: PricingContext,
  ctx: AdaptContext,
): PricingObservation | null {
  if (pricingInput.list_price === null && pricingInput.sale_price === null) {
    return null;
  }
  const tiers: PricingObservation["tiers"] = [];
  if (pricingInput.list_price !== null) {
    tiers.push({ kind: "list", amount: pricingInput.list_price });
  }
  if (pricingInput.sale_price !== null) {
    tiers.push({ kind: "sale", amount: pricingInput.sale_price });
  }
  const currency = pricingInput.currency ?? ctx.channelDefaultCurrency;
  if (currency === null) {
    throw new Error(
      "linkAdapter: pricing currency missing from both sku.pricing.currency and ctx.channelDefaultCurrency",
    );
  }
  return {
    productHint: pctx.productHint,
    ...(pctx.variantAxes !== undefined ? { variantAxes: pctx.variantAxes } : {}),
    channelCode: pctx.channelCode,
    locale: pctx.locale,
    source: pctx.source,
    sourceRecordId: pctx.sourceRecordId,
    currency,
    tiers,
    observedAt: pctx.observedAt,
    ...(pctx.artifactId !== undefined ? { artifactId: pctx.artifactId } : {}),
  };
}

/**
 * Link adapter — maps SkuJson (output of the link-extraction pipeline)
 * into the canonical observation model.
 *
 * NOTE: this module deliberately does NOT call registerAdapter() at import
 * time. The package's main entry point (`src/index.ts`, wired up in Task 2.6)
 * is responsible for registration. This keeps test imports of fixtures from
 * polluting the global registry.
 */
export const linkAdapter: SourceAdapter = {
  sourceKind: "link",
  adapt,
};

export type { SkuJson, SkuVariant, SkuImage };
