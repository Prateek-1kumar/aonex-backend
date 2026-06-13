// Normalizes a raw Shopify product into a CanonicalProductRecord: strips Nango
// metadata, derives externalId from `id`, and lifts updated_at into modifiedAt.
// Only the record envelope is normalized; canonical field mapping happens later.

import { removeNangoMetadata } from "@aonex/lib-utils";
import type { CanonicalProductRecord } from "../../../contract/records.js";
import type { Marketplace } from "@aonex/types";

interface ShopifyRecord {
  id: string | number;
  updated_at?: string;
  [k: string]: unknown;
}

export function normalizeShopifyProduct(
  raw: Record<string, unknown>,
  ctx: { marketplace: Marketplace }
): CanonicalProductRecord {
  const stripped = removeNangoMetadata(raw) as ShopifyRecord;
  const externalId = String(stripped.id ?? "");
  if (!externalId) {
    throw new Error("Shopify record missing `id`");
  }
  const result: CanonicalProductRecord = {
    externalId,
    marketplace: ctx.marketplace,
    raw: stripped as Record<string, unknown>
  };
  if (stripped.updated_at) {
    const d = new Date(stripped.updated_at);
    if (!isNaN(d.getTime())) {
      result.modifiedAt = d;
    }
  }
  return result;
}
