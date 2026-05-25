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
 * Shopify product variant shape consumed by this adapter.
 *
 * This is a forward-compatible *superset* of the current Nango-synced shape in
 * apps/nango/shopify/syncs/shopify-products.ts. The Nango sync currently does
 * NOT pull `compareAtPrice` or `weight` (it uses GraphQL with a minimal field
 * set), but Shopify's API does expose them and the plan calls for mapping
 * those fields when present. When they're absent the adapter simply skips the
 * corresponding observations — no errors, no synthesised values.
 */
export interface ShopifyVariant {
  id: string;
  title: string;
  sku?: string | null;
  barcode?: string | null;
  price: string;
  /** Future-compat: shopify exposes compareAtPrice, sync doesn't pull it yet. */
  compareAtPrice?: string | null;
  inventoryQuantity: number;
  /** Future-compat: shopify exposes weight (number, default kg). */
  weight?: number | null;
  selectedOptions: Array<{ name: string; value: string }>;
}

/**
 * Shopify product shape consumed by this adapter.
 *
 * Same forward-compatibility note as `ShopifyVariant`: `body_html` isn't in
 * the current Nango sync but the REST/GraphQL Shopify API exposes it. The
 * adapter tolerates the field being absent.
 */
export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor?: string | null;
  productType?: string | null;
  tags: string[];
  updated_at: string;
  /** Future-compat: HTML body of the product description. */
  body_html?: string | null;
  options: Array<{ name: string; values: string[] }>;
  images: Array<{ url: string; altText?: string | null }>;
  variants: ShopifyVariant[];
}

/**
 * Envelope shape consumed by the shopify-connector adapter.
 *
 * Why this is not just the raw Shopify product: the Nango payload doesn't
 * carry the connection's shop domain, the time the snapshot was taken, or
 * the artifact id of the originating sync run. Callers (the catalog-service
 * sync wrapper in Phase 3) wrap a ShopifyProduct in this envelope before
 * invoking the adapter — keeping the Nango sync output coupling-free.
 */
export interface ShopifyAdapterInput {
  product: ShopifyProduct;
  /** e.g. "demo-shop.myshopify.com" */
  shopDomain: string;
  observedAt: string | Date;
  artifactId?: ArtifactId;
}

/**
 * Channel-code derivation from a Shopify shop domain.
 *
 * The catalog-redesign spec §13 line 836 uses `channel_scope shopify-*` so
 * the channel code starts with `shopify-`. The suffix is the inferred region:
 *
 * - *.myshopify.com           → "shopify-au" (default region — Task 1.12 bootstrap default)
 * - explicit-region subdomain → not currently inferred (Shopify doesn't surface region
 *   in the domain). Region inference is a Task 1.12 / channel-config concern, NOT the
 *   adapter's: the adapter applies the conservative default `shopify-au` and lets the
 *   bootstrap layer override per-tenant.
 *
 * Heuristic: drop port/auth/etc. via URL parsing isn't needed for bare hostnames;
 * we just inspect the suffix. Anything ending in `.myshopify.com` is treated as
 * AU-default. Other custom domains also default to `shopify-au` — they're already
 * scoped per-tenant by the channel id.
 */
export function channelCodeFromShopDomain(_shopDomain: string): string {
  return "shopify-au";
}

const DEFAULT_CONFIDENCE = 0.85;
/** Per plan: category derived from productType is a low-confidence hint. */
const CATEGORY_HINT_CONFIDENCE = 0.5;
/** Identity (gtin/barcode) signals are high-confidence by convention. */
const IDENTITY_CONFIDENCE = 0.9;

/** Source string per spec §13 — Shopify connector is one logical source. */
const SOURCE = "shopify:connector";

function adapt(input: unknown, ctx: AdaptContext): AdapterOutput {
  const envelope = input as ShopifyAdapterInput;
  if (!envelope || !envelope.product || !envelope.shopDomain) {
    throw new Error(
      "shopifyConnectorAdapter: expected ShopifyAdapterInput { product, shopDomain, observedAt }",
    );
  }
  const product = envelope.product;
  const channelCode = channelCodeFromShopDomain(envelope.shopDomain);
  const locale = ctx.channelDefaultLocale ?? "_unscoped";
  const recordId = product.id;
  const observedAt =
    envelope.observedAt instanceof Date
      ? envelope.observedAt
      : new Date(envelope.observedAt);

  const observations: CanonicalObservation[] = [];
  const pricing: PricingObservation[] = [];
  const inventory: InventoryObservation[] = [];

  // --- Parent-level observations ------------------------------------------------

  // title — channel-scoped. handle (URL slug) preserved in extras so it isn't
  // silently dropped, but isn't first-class enough to merit its own observation.
  observations.push({
    attributeCode: "title",
    target: "parent",
    channelCode,
    localeCode: locale,
    source: SOURCE,
    sourceRecordId: recordId,
    value: product.title,
    confidence: DEFAULT_CONFIDENCE,
    observedAt,
    extras: { handle: product.handle },
  });

  // status — channel-scoped (a product can be ACTIVE on one channel, DRAFT on another).
  observations.push({
    attributeCode: "status",
    target: "parent",
    channelCode,
    localeCode: locale,
    source: SOURCE,
    sourceRecordId: recordId,
    value: product.status,
    confidence: DEFAULT_CONFIDENCE,
    observedAt,
  });

  // vendor → brand at _unscoped/_unscoped. The plan notes "synonym lookup
  // verified" — vendor IS the brand on Shopify, so synonyms aren't strictly
  // required, but if ctx.attributeSynonyms maps "vendor"→"brand" we'd already
  // be emitting `brand` directly. Either way we emit the canonical key here.
  if (product.vendor != null) {
    observations.push({
      attributeCode: "brand",
      target: "parent",
      channelCode: "_unscoped",
      localeCode: "_unscoped",
      source: SOURCE,
      sourceRecordId: recordId,
      value: product.vendor,
      confidence: IDENTITY_CONFIDENCE,
      observedAt,
    });
  }

  // productType → category_path hint (low confidence per plan).
  if (product.productType != null) {
    observations.push({
      attributeCode: "category_path",
      target: "parent",
      channelCode,
      localeCode: locale,
      source: SOURCE,
      sourceRecordId: recordId,
      value: product.productType,
      confidence: CATEGORY_HINT_CONFIDENCE,
      observedAt,
    });
  }

  // tags → single observation holding the array. Per plan ("Pick single
  // observation `{attributeCode: 'tags', value: tagsArray}` for simplicity.").
  if (product.tags.length > 0) {
    observations.push({
      attributeCode: "tags",
      target: "parent",
      channelCode,
      localeCode: locale,
      source: SOURCE,
      sourceRecordId: recordId,
      value: product.tags,
      confidence: DEFAULT_CONFIDENCE,
      observedAt,
    });
  }

  // body_html → description_long (only when present — current Nango sync doesn't pull it).
  if (product.body_html != null) {
    observations.push({
      attributeCode: "description_long",
      target: "parent",
      channelCode,
      localeCode: locale,
      source: SOURCE,
      sourceRecordId: recordId,
      value: product.body_html,
      confidence: DEFAULT_CONFIDENCE,
      observedAt,
    });
  }

  // images — one observation holding the array.
  if (product.images.length > 0) {
    observations.push({
      attributeCode: "images",
      target: "parent",
      channelCode,
      localeCode: locale,
      source: SOURCE,
      sourceRecordId: recordId,
      value: product.images,
      confidence: DEFAULT_CONFIDENCE,
      observedAt,
    });
  }

  // options (variant-axis declarations) preserved as one observation.
  if (product.options.length > 0) {
    observations.push({
      attributeCode: "options",
      target: "parent",
      channelCode,
      localeCode: locale,
      source: SOURCE,
      sourceRecordId: recordId,
      value: product.options,
      confidence: DEFAULT_CONFIDENCE,
      observedAt,
    });
  }

  // --- Variants -----------------------------------------------------------------

  for (const variant of product.variants) {
    const variantAxes = optionsToAxes(variant.selectedOptions);
    const variantRecordId = variant.id;
    const productHint =
      variant.barcode ?? variant.sku ?? `${product.id}-${variant.id}`;

    // identity.sku at channel (sku is channel-specific identity).
    if (variant.sku != null) {
      observations.push({
        attributeCode: "identity.sku",
        target: "variant",
        variantAxes,
        channelCode,
        localeCode: locale,
        source: SOURCE,
        sourceRecordId: variantRecordId,
        value: variant.sku,
        confidence: DEFAULT_CONFIDENCE,
        observedAt,
      });
    }

    // identity.gtin at _unscoped (global identifier).
    if (variant.barcode != null) {
      observations.push({
        attributeCode: "identity.gtin",
        target: "variant",
        variantAxes,
        channelCode: "_unscoped",
        localeCode: "_unscoped",
        source: SOURCE,
        sourceRecordId: variantRecordId,
        value: variant.barcode,
        confidence: IDENTITY_CONFIDENCE,
        observedAt,
      });
    }

    // weight (number, no unit on the wire) → kg per Shopify convention.
    // attribute_definitions.canonical_unit on `weight` is the authoritative
    // place to resolve this; the adapter emits the unit via extras so the
    // reconciler doesn't have to guess.
    if (variant.weight != null) {
      observations.push({
        attributeCode: "weight",
        target: "variant",
        variantAxes,
        channelCode,
        localeCode: locale,
        source: SOURCE,
        sourceRecordId: variantRecordId,
        value: variant.weight,
        confidence: DEFAULT_CONFIDENCE,
        observedAt,
        extras: { unit: "kg" },
      });
    }

    // Pricing — list (+ compare when present). Shopify variants don't carry
    // currency at the variant level — it's account-level, so we rely on
    // ctx.channelDefaultCurrency exclusively.
    if (ctx.channelDefaultCurrency === null) {
      throw new Error(
        "shopifyConnectorAdapter: ctx.channelDefaultCurrency required (Shopify variants don't carry currency)",
      );
    }
    const tiers: PricingObservation["tiers"] = [
      { kind: "list", amount: parseFloat(variant.price) },
    ];
    if (variant.compareAtPrice != null) {
      tiers.push({ kind: "compare", amount: parseFloat(variant.compareAtPrice) });
    }
    pricing.push({
      productHint,
      variantAxes,
      channelCode,
      locale,
      source: SOURCE,
      sourceRecordId: variantRecordId,
      currency: ctx.channelDefaultCurrency,
      tiers,
      observedAt,
      ...(envelope.artifactId !== undefined ? { artifactId: envelope.artifactId } : {}),
    });

    // Inventory — one observation per variant.
    inventory.push({
      productHint,
      variantAxes,
      channelCode,
      qty: variant.inventoryQuantity,
      source: SOURCE,
      sourceRecordId: variantRecordId,
      observedAt,
      ...(envelope.artifactId !== undefined ? { artifactId: envelope.artifactId } : {}),
    });
  }

  // --- Identity hint ------------------------------------------------------------

  const firstVariantBarcode = product.variants.find((v) => v.barcode != null)
    ?.barcode;
  const identityHint: IdentityHint = {
    ...(firstVariantBarcode != null ? { gtin: firstVariantBarcode } : {}),
    ...(product.vendor != null ? { brand: product.vendor } : {}),
    titleForFuzzy: product.title,
    targetIsVariant: product.variants.length > 0,
  };

  return {
    observations,
    pricingObservations: pricing,
    inventoryObservations: inventory,
    identityHint,
    rawPayload: product,
  };
}

/** Convert Shopify's `[{name, value}, ...]` selectedOptions into a `{name: value}` map. */
function optionsToAxes(
  selected: Array<{ name: string; value: string }>,
): Record<string, string> {
  const axes: Record<string, string> = {};
  for (const { name, value } of selected) {
    axes[name] = value;
  }
  return axes;
}

/**
 * Shopify connector adapter — maps Nango-synced Shopify product payloads into
 * the canonical observation model.
 *
 * NOTE: this module deliberately does NOT call registerAdapter() at import
 * time. The package's main entry point (`src/index.ts`, wired up in Task 2.6)
 * is responsible for registration. This keeps test imports of fixtures from
 * polluting the global registry.
 */
export const shopifyConnectorAdapter: SourceAdapter = {
  sourceKind: "shopify-connector",
  adapt,
};
