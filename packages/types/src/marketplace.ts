// Marketplace identity: the canonical Marketplace union and its guard. This is
// the only repo-wide place a marketplace name is declared; adding one means a
// line here plus a new normalizer file and sync script.

export const MARKETPLACES = ["shopify", "amazon", "ebay", "walmart", "etsy"] as const;

export type Marketplace = (typeof MARKETPLACES)[number];

export function isMarketplace(value: unknown): value is Marketplace {
  return typeof value === "string" && (MARKETPLACES as readonly string[]).includes(value);
}

/**
 * Per-marketplace rollout phase, used by `/api/connections` to gate which
 * marketplaces a merchant can connect right now.
 */
export const MARKETPLACE_PHASE: Record<Marketplace, number> = {
  shopify: 1,
  amazon: 3,
  ebay: 4,
  walmart: 5,
  etsy: 5
};
