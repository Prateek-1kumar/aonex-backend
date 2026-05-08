// Shopify → CanonicalProductRecord. Vendor noise stripped here.
// HLD §16.3: Shopify product fields. Phase 1 only normalizes the
// raw record envelope; field mapping into the canonical schema is
// the Phase 2 Field Extractor's job.

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
