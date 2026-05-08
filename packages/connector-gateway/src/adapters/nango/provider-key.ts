// Marketplace ↔ Nango providerConfigKey mapping. The ONLY place
// providerConfigKey is materialized — vendor concept lives in the
// gateway, never in business code.

import type { Marketplace } from "@aonex/types";

const TO_NANGO: Record<Marketplace, string> = {
  shopify: "shopify",
  amazon: "amazon-selling-partner",
  ebay: "ebay",
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

/** Sync names per LLD §11 — must match `nango deploy` script names. */
export const SYNC_NAMES: Record<Marketplace, readonly string[]> = {
  shopify: ["shopify-products"],
  amazon: ["amazon-catalog-items"],
  ebay: ["ebay-inventory-items"],
  walmart: [],
  etsy: []
};
