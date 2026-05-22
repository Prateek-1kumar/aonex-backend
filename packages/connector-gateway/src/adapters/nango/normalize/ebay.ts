import { removeNangoMetadata } from "@aonex/lib-utils";
import type { CanonicalProductRecord } from "../../../contract/records.js";
import type { Marketplace } from "@aonex/types";

interface EbayRecord {
  sku?: string;
  orderId?: string;
  offerId?: string;
  lastModifiedDate?: string;
  creationDate?: string;
  [k: string]: unknown;
}

export function normalizeEbayRecord(
  raw: Record<string, unknown>,
  ctx: { marketplace: Marketplace }
): CanonicalProductRecord {
  const stripped = removeNangoMetadata(raw) as EbayRecord;
  const externalId = String(stripped.orderId ?? stripped.offerId ?? stripped.sku ?? "");
  if (!externalId) {
    throw new Error("eBay record missing stable id (orderId / offerId / sku)");
  }
  const result: CanonicalProductRecord = {
    externalId,
    marketplace: ctx.marketplace,
    raw: stripped as Record<string, unknown>
  };
  const ts = stripped.lastModifiedDate ?? stripped.creationDate;
  if (ts) {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) result.modifiedAt = d;
  }
  return result;
}
