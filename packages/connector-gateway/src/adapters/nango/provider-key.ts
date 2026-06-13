// Marketplace <-> Nango providerConfigKey mapping; the only place the
// vendor-specific providerConfigKey is materialized, keeping it out of
// business code.

import type { Marketplace } from "@aonex/types";

const TO_NANGO: Record<Marketplace, string> = {
  shopify: "shopify",
  amazon: "amazon-selling-partner",
  ebay: "ebay-sandbox",
  walmart: "walmart",
  etsy: "etsy"
};

const FROM_NANGO: Record<string, Marketplace> = Object.fromEntries(
  Object.entries(TO_NANGO).map(([m, p]) => [p, m as Marketplace])
);

export function toProviderKey(marketplace: Marketplace): string {
  return TO_NANGO[marketplace];
}

export function fromProviderKey(providerKey: string): Marketplace | null {
  return FROM_NANGO[providerKey] ?? null;
}

/** Sync model names per marketplace; must match the deployed `nango` script names. */
export const SYNC_NAMES: Record<Marketplace, readonly string[]> = {
  shopify: ["shopify-products"],
  amazon: ["amazon-catalog-items"],
  ebay: ["ebay-inventory-items", "ebay-orders", "ebay-offers"],
  walmart: [],
  etsy: []
};
