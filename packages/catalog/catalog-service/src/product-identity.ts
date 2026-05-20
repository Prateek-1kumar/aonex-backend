import { and, eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { type CanonicalProductPayload } from "./payload-parser.js";

export async function resolveExistingProductId(
  db: DrizzleClient,
  tenantId: string,
  payload: CanonicalProductPayload
): Promise<string | null> {
  const identities = buildIdentityValues(payload);
  for (const identity of identities) {
    const row = await db.query.productIdentities.findFirst({
      where: (pi, { and, eq }) =>
        and(
          eq(pi.tenantId, tenantId),
          eq(pi.identityType, identity.type),
          eq(pi.identityValue, identity.value)
        ),
    });
    if (row) return row.productId;
  }
  return null;
}

export async function persistIdentities(
  db: DrizzleClient,
  tenantId: string,
  productId: string,
  payload: CanonicalProductPayload
): Promise<void> {
  const identities = buildIdentityValues(payload);
  if (identities.length === 0) return;

  await db
    .insert(schema.productIdentities)
    .values(
      identities.map((identity) => ({
        productId,
        tenantId,
        identityType: identity.type,
        identityValue: identity.value,
      }))
    )
    .onConflictDoNothing();
}

function buildIdentityValues(payload: CanonicalProductPayload): Array<{ type: string; value: string }> {
  const identities: Array<{ type: string; value: string }> = [];
  if (payload.gtin) identities.push({ type: "gtin", value: payload.gtin });
  if (payload.modelNumber) identities.push({ type: "mpn", value: payload.modelNumber });
  if (payload.brand && payload.modelNumber) {
    identities.push({
      type: "brand_mpn",
      value: `${payload.brand.trim().toLowerCase()}:${payload.modelNumber.trim().toLowerCase()}`,
    });
  }
  for (const variant of payload.variants) {
    if (variant.sku) identities.push({ type: "sku", value: variant.sku });
    if (variant.barcode) identities.push({ type: "gtin", value: variant.barcode });
  }
  return dedupeIdentities(identities);
}

function dedupeIdentities(
  identities: Array<{ type: string; value: string }>
): Array<{ type: string; value: string }> {
  const seen = new Set<string>();
  return identities.filter((identity) => {
    const value = identity.value.trim();
    if (!value) return false;
    const key = `${identity.type}:${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    identity.value = value;
    return true;
  });
}
