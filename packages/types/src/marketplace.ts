// Marketplace identity — HLD §11 / §16. Phase 1 ships Shopify;
// Amazon, eBay, Walmart, Etsy follow in later phases per HLD §26.
//
// The order of additions to this union is the ONLY repo-wide
// place a marketplace name appears. Adding a marketplace = one
// line here + one new normalizer file + one new sync script.
// (Engineering principles, OCP rule.)

export const MARKETPLACES = ["shopify", "amazon", "ebay", "walmart", "etsy"] as const;

export type Marketplace = (typeof MARKETPLACES)[number];

export function isMarketplace(value: unknown): value is Marketplace {
  return typeof value === "string" && (MARKETPLACES as readonly string[]).includes(value);
}

/**
 * Phase mapping per HLD §26. Used by `/api/connections` to gate
 * which marketplaces the merchant can connect right now.
 */
export const MARKETPLACE_PHASE: Record<Marketplace, number> = {
  shopify: 1,
  amazon: 3,
  ebay: 4,
  walmart: 5,
  etsy: 5
};
