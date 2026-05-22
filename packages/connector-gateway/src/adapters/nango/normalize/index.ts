// Per-marketplace normalizer registry. Strategy + Registry pattern —
// engineering principles forbid `if (marketplace === 'shopify')`
// chains in adapter code.

import type { Marketplace } from "@aonex/types";
import type { CanonicalProductRecord } from "../../../contract/records.js";
import { normalizeShopifyProduct } from "./shopify.js";
import { normalizeEbayRecord } from "./ebay.js";

export type Normalizer = (
  raw: Record<string, unknown>,
  merchantContext: { marketplace: Marketplace }
) => CanonicalProductRecord;

const REGISTRY: Partial<Record<Marketplace, Normalizer>> = {
  shopify: normalizeShopifyProduct,
  ebay: normalizeEbayRecord
};

export function normalizerFor(marketplace: Marketplace): Normalizer {
  const fn = REGISTRY[marketplace];
  if (!fn) {
    throw new Error(`No normalizer registered for marketplace=${marketplace}`);
  }
  return fn;
}
