import { and, eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { canonicalStringify, sha256Hex } from "@aonex/lib-utils";

export interface CanonicalVariantPayload {
  sku: string | null;
  barcode: string | null;
  price: number | null;
  currency: string | null;
  inventoryQuantity: number | null;
  optionValues: Record<string, string>;
}

export interface CanonicalProductPayload {
  title: string | null;
  brand: string | null;
  gtin: string | null;
  modelNumber: string | null;
  description: string | null;
  basePrice: number | null;
  currency: string | null;
  canonicalCategory: string | null;
  images: Array<{ url: string; altText?: string }>;
  attributes: Record<string, unknown>;
  variants: CanonicalVariantPayload[];
  evidence: Record<string, unknown>;
}

export interface ApplyApprovedDiffInput {
  db: DrizzleClient;
  diffId: string;
  actorId?: string | null;
  approvalStatus: "approved" | "auto_approved";
}

export interface ApplyApprovedDiffResult {
  productId: string;
  productVersionId: string;
  createdVersion: boolean;
}

export async function applyApprovedDiff(
  input: ApplyApprovedDiffInput
): Promise<ApplyApprovedDiffResult> {
  const existingVersion = await input.db.query.productVersions.findFirst({
    where: (pv, { eq }) => eq(pv.proposedDiffId, input.diffId),
  });

  if (existingVersion) {
    return {
      productId: existingVersion.productId,
      productVersionId: existingVersion.id,
      createdVersion: false,
    };
  }

  const diff = await input.db.query.proposedDiffs.findFirst({
    where: (d, { eq }) => eq(d.id, input.diffId),
  });

  if (!diff) {
    throw new Error(`proposed_diff ${input.diffId} not found`);
  }

  const rawPayload = parseCanonicalPayload(diff.diffPayload);
  // Self-heal: when the reviewer or a frontend bug blanks a core field, fall
  // back to whatever the original extraction produced. extracted_facts is the
  // source of truth for what we actually parsed; the diff payload is just the
  // canonical projection of it. We should never refuse to materialize a product
  // when the underlying extraction had the data.
  const payload = await rehydrateFromExtractedFacts(input.db, diff.sourceFactSetId, rawPayload);
  if (!payload.title) {
    throw new Error("Cannot apply catalog version without canonical title");
  }

  await input.db
    .update(schema.proposedDiffs)
    .set({
      status: input.approvalStatus,
      actorType: input.approvalStatus === "auto_approved" ? "policy" : "user",
      actorId: input.actorId ?? null,
      reviewedAt: new Date(),
    })
    .where(eq(schema.proposedDiffs.id, input.diffId));

  let productId = diff.productId;
  if (!productId) {
    productId = await resolveExistingProductId(input.db, diff.tenantId, payload);
  }

  if (!productId) {
    const [product] = await input.db
      .insert(schema.products)
      .values({
        tenantId: diff.tenantId,
        merchantId: diff.merchantId,
        status: "active",
        canonicalCategory: payload.canonicalCategory,
      })
      .returning({ id: schema.products.id });

    if (!product) {
      throw new Error("Failed to create product");
    }
    productId = product.id;
  }

  await input.db
    .update(schema.proposedDiffs)
    .set({ productId })
    .where(eq(schema.proposedDiffs.id, input.diffId));

  const [version] = await input.db
    .insert(schema.productVersions)
    .values({
      productId,
      tenantId: diff.tenantId,
      merchantId: diff.merchantId,
      proposedDiffId: input.diffId,
      title: payload.title,
      brand: payload.brand,
      gtin: payload.gtin,
      modelNumber: payload.modelNumber,
      basePrice: payload.basePrice == null ? null : String(payload.basePrice),
      currency: payload.currency,
      images: payload.images,
      description: payload.description,
      canonicalCategory: payload.canonicalCategory,
      confidenceScore: String(diff.confidenceScore),
      merchantExtensionsJson: {
        attributes: payload.attributes,
        evidence: payload.evidence,
      },
    })
    .returning({ id: schema.productVersions.id });

  if (!version) {
    throw new Error("Failed to create product version");
  }

  await input.db
    .update(schema.products)
    .set({
      currentVersionId: version.id,
      status: "active",
      canonicalCategory: payload.canonicalCategory,
      updatedAt: new Date(),
    })
    .where(eq(schema.products.id, productId));

  await persistIdentities(input.db, diff.tenantId, productId, payload);
  await persistVariants(input.db, diff.tenantId, productId, version.id, payload);

  return { productId, productVersionId: version.id, createdVersion: true };
}

/**
 * Defensive: when the diff payload is missing a core field, look it up from
 * extracted_facts. This makes the system robust against reviewer/frontend bugs
 * that accidentally blank fields during edit-and-approve flows. extracted_facts
 * is immutable, so this is always safe — we're only filling holes, never
 * overriding a value the reviewer actually set.
 */
async function rehydrateFromExtractedFacts(
  db: DrizzleClient,
  sourceFactSetId: string,
  payload: CanonicalProductPayload
): Promise<CanonicalProductPayload> {
  // Map: payload field name → extracted_facts raw_key candidates (first match wins).
  const FIELD_FALLBACKS: Array<{ key: keyof CanonicalProductPayload; rawKeys: string[]; coerce: (v: unknown) => unknown }> = [
    { key: "title",             rawKeys: ["title"],                              coerce: toStr },
    { key: "brand",             rawKeys: ["brand", "vendor"],                    coerce: toStr },
    { key: "gtin",              rawKeys: ["gtin", "barcode"],                    coerce: toStr },
    { key: "modelNumber",       rawKeys: ["modelNumber", "model_number", "mpn"], coerce: toStr },
    { key: "description",       rawKeys: ["description"],                        coerce: toStr },
    { key: "basePrice",         rawKeys: ["basePrice", "base_price", "price"],   coerce: toNum },
    { key: "currency",          rawKeys: ["currency"],                           coerce: (v) => (typeof v === "string" ? v.toUpperCase() : null) },
    { key: "canonicalCategory", rawKeys: ["canonicalCategory", "productType", "category_path"], coerce: toStr },
  ];

  // Identify which fields need a fallback (current value is null/empty).
  const needed = FIELD_FALLBACKS.filter((f) => {
    const current = payload[f.key];
    return current == null || (typeof current === "string" && current.trim() === "");
  });
  if (needed.length === 0) return payload;

  const wantedRawKeys = new Set(needed.flatMap((f) => f.rawKeys));
  const facts = await db.query.extractedFacts.findMany({
    where: (ef, { eq }) => eq(ef.factSetId, sourceFactSetId),
  });

  const next: CanonicalProductPayload = { ...payload };
  for (const fb of needed) {
    for (const rawKey of fb.rawKeys) {
      if (!wantedRawKeys.has(rawKey)) continue;
      const hit = facts.find((f) => f.rawKey === rawKey);
      if (!hit) continue;
      const value = hit.normalizedValue ?? hit.extractedValue;
      const coerced = fb.coerce(value);
      if (coerced == null) continue;
      if (typeof coerced === "string" && coerced.trim() === "") continue;
      // Assign with a type-safe cast: each fb.key maps to a compatible coerce output.
      (next as Record<string, unknown>)[fb.key as string] = coerced;
      break;
    }
  }
  return next;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

async function resolveExistingProductId(
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

async function persistIdentities(
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

async function persistVariants(
  db: DrizzleClient,
  tenantId: string,
  productId: string,
  productVersionId: string,
  payload: CanonicalProductPayload
): Promise<void> {
  for (const variant of payload.variants) {
    const variantKey = sha256Hex(canonicalStringify(variant.optionValues)).slice(0, 64);
    const existing = await db.query.productVariants.findFirst({
      where: (pv, { and, eq }) =>
        and(eq(pv.productId, productId), eq(pv.variantKey, variantKey)),
    });

    const variantId =
      existing?.id ??
      (
        await db
          .insert(schema.productVariants)
          .values({ productId, tenantId, variantKey })
          .returning({ id: schema.productVariants.id })
      )[0]?.id;

    if (!variantId) {
      throw new Error("Failed to create product variant");
    }

    const [variantVersion] = await db
      .insert(schema.productVariantVersions)
      .values({
        variantId,
        productVersionId,
        tenantId,
        sku: variant.sku,
        barcode: variant.barcode,
        price: variant.price == null ? null : String(variant.price),
        currency: variant.currency,
        inventoryQuantity:
          variant.inventoryQuantity == null ? null : String(variant.inventoryQuantity),
        variantAxes: variant.optionValues,
      })
      .returning({ id: schema.productVariantVersions.id });

    if (!variantVersion) {
      throw new Error("Failed to create product variant version");
    }

    await db
      .update(schema.productVariants)
      .set({ currentVariantVersionId: variantVersion.id })
      .where(eq(schema.productVariants.id, variantId));
  }
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

function parseCanonicalPayload(raw: Record<string, unknown>): CanonicalProductPayload {
  return {
    title: stringOrNull(raw.title),
    brand: stringOrNull(raw.brand),
    gtin: stringOrNull(raw.gtin),
    modelNumber: stringOrNull(raw.modelNumber ?? raw.model_number),
    description: stringOrNull(raw.description),
    basePrice: numberOrNull(raw.basePrice ?? raw.base_price),
    currency: stringOrNull(raw.currency)?.toUpperCase() ?? null,
    canonicalCategory: stringOrNull(raw.canonicalCategory ?? raw.canonical_category),
    images: parseImages(raw.images),
    attributes: isRecord(raw.attributes) ? raw.attributes : {},
    variants: Array.isArray(raw.variants) ? raw.variants.map(parseVariant) : [],
    evidence: isRecord(raw.evidence) ? raw.evidence : {},
  };
}

function parseVariant(raw: unknown): CanonicalVariantPayload {
  const record = isRecord(raw) ? raw : {};
  return {
    sku: stringOrNull(record.sku),
    barcode: stringOrNull(record.barcode),
    price: numberOrNull(record.price),
    currency: stringOrNull(record.currency)?.toUpperCase() ?? null,
    inventoryQuantity: numberOrNull(record.inventoryQuantity ?? record.inventory_quantity),
    optionValues: parseOptionValues(record.optionValues ?? record.option_values),
  };
}

function parseImages(raw: unknown): Array<{ url: string; altText?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const url = stringOrNull(item.url);
    if (!url) return [];
    const image: { url: string; altText?: string } = { url };
    const altText = stringOrNull(item.altText ?? item.alt_text);
    if (altText) image.altText = altText;
    return [image];
  });
}

function parseOptionValues(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = stringOrNull(value);
    if (normalized) out[key] = normalized;
  }
  return out;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
