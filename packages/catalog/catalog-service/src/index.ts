import { eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { canonicalStringify, sha256Hex } from "@aonex/lib-utils";
import { validate, type ValidationOutcome } from "@aonex/schema-validator";
import {
  decideReconciliationAction,
  type ProductIdentity
} from "@aonex/multi-source-reconciler";
import {
  type CanonicalVariantPayload,
  type CanonicalProductPayload,
  parseCanonicalPayload,
  toStr,
  toNum,
} from "./payload-parser.js";
import {
  resolveExistingProductId,
  persistIdentities,
} from "./product-identity.js";

export type { CanonicalVariantPayload, CanonicalProductPayload };

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

  // Load the latest category_schemas row for this canonical_category so we can:
  //   (a) validate attributes_json when the schema is authoritative (Tier 1)
  //   (b) stamp categorySchemaVersion onto the product_version
  const categorySchemaRow = payload.canonicalCategory
    ? await input.db.query.categorySchemas.findFirst({
        where: (c, { eq }) => eq(c.categoryPath, payload.canonicalCategory!),
        orderBy: (c, { desc }) => [desc(c.schemaVersion)],
      })
    : null;

  // Validation gate. Tier-1 (authoritative) failures block the approval entirely
  // and open a review_task. Tier-2 (inferred) is permissive and never blocks.
  if (
    categorySchemaRow?.jsonSchema &&
    categorySchemaRow.tier === "authoritative"
  ) {
    const outcome: ValidationOutcome = validate(
      categorySchemaRow.jsonSchema as Record<string, unknown>,
      payload.attributes
    );
    if (!outcome.valid) {
      await emitMissingRequiredReviewTask({
        db: input.db,
        diff: { id: diff.id, tenantId: diff.tenantId, merchantId: diff.merchantId },
        outcome,
        categorySchemaRow: {
          categoryPath: categorySchemaRow.categoryPath,
          schemaVersion: categorySchemaRow.schemaVersion,
        },
      });
      throw new Error(
        `Validation failed for ${payload.canonicalCategory}: missing required = ${outcome.missingRequired.join(", ")}`
      );
    }
  }

  // The product_versions insert trigger checks that the referencing diff has
  // status ∈ {approved, auto_approved}, so we must flip status before inserting.
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
  } else {
    // Phase 9 — multi-source reconciliation observability.
    // Compare incoming payload identity to the existing product's latest version's
    // identity. When the composite score falls below the auto-merge threshold,
    // emit a value_conflict review_task so a human reviews the merge before
    // downstream distribution.
    try {
      const existingProductVersion = await input.db.query.productVersions.findFirst({
        where: (pv, { eq: eqFn }) => eqFn(pv.productId, productId!),
        orderBy: (pv, { desc }) => [desc(pv.createdAt)]
      });
      if (existingProductVersion) {
        const incoming: ProductIdentity = {
          gtin: payload.gtin ?? null,
          modelNumber: payload.modelNumber ?? null,
          title: payload.title ?? null,
          brand: payload.brand ?? null
        };
        const existing: ProductIdentity = {
          gtin: existingProductVersion.gtin ?? null,
          modelNumber: existingProductVersion.modelNumber ?? null,
          title: existingProductVersion.title ?? null,
          brand: existingProductVersion.brand ?? null
        };
        const decision = decideReconciliationAction(incoming, existing);
        if (decision.action === "review") {
          await input.db.insert(schema.reviewTasks).values({
            tenantId: diff.tenantId as never,
            merchantId: diff.merchantId as never,
            proposedDiffId: input.diffId,
            artifactId: null,
            taskType: "value_conflict",
            signalKind: "value_conflict",
            signalPayload: {
              reason: "multi_source_reconciler_review",
              existingProductId: productId,
              score: decision.score,
              incoming: {
                gtin: incoming.gtin,
                brand: incoming.brand,
                title: incoming.title
              },
              existing: {
                gtin: existing.gtin,
                brand: existing.brand,
                title: existing.title
              }
            },
            severity: "medium",
            clusterKey: `value_conflict:${productId}`,
            fieldName: null,
            policyVersionId: null
          }).returning({ id: schema.reviewTasks.id });
        } else if (decision.action === "keep_separate") {
          // eslint-disable-next-line no-console
          console.warn("[catalog-service] reconciler suggested keep_separate but GTIN matched existing product", {
            productId,
            score: decision.score.composite,
            incomingTitle: incoming.title,
            existingTitle: existing.title
          });
        }
        // action === "merge" → silent, existing behavior preserved.
      }
    } catch (err) {
      // Reconciler shouldn't block the merge — log and continue.
      // eslint-disable-next-line no-console
      console.warn("[catalog-service] reconciler check failed", err instanceof Error ? err.message : err);
    }
  }

  await input.db
    .update(schema.proposedDiffs)
    .set({ productId })
    .where(eq(schema.proposedDiffs.id, input.diffId));

  // Only stamp categorySchemaVersion when the schema actually exists and is Tier 1.
  // A row with tier="authoritative" but jsonSchema=null skipped validation above —
  // we should not pretend the version was validated against a schema that wasn't loaded.
  const stampSchemaVersion =
    categorySchemaRow != null &&
    categorySchemaRow.tier === "authoritative" &&
    categorySchemaRow.jsonSchema != null;

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
      gtinType: payload.gtinType,
      modelNumber: payload.modelNumber,
      manufacturerPartNumber: payload.manufacturerPartNumber,
      basePrice: payload.basePrice == null ? null : String(payload.basePrice),
      currency: payload.currency,
      weightGrams: payload.weightGrams == null ? null : String(payload.weightGrams),
      dimensionsCm: payload.dimensionsCm,
      images: payload.images,
      description: payload.description,
      canonicalCategory: payload.canonicalCategory,
      categorySchemaVersion:
        stampSchemaVersion && categorySchemaRow
          ? `${categorySchemaRow.categoryPath}/v${categorySchemaRow.schemaVersion}`
          : null,
      categoryConfidence:
        payload.categoryConfidence == null ? null : String(payload.categoryConfidence),
      attributesJson: payload.attributes,
      confidenceScore: String(diff.confidenceScore),
      // Legacy slot — its contents now live in attributesJson + evidenceSummary.
      merchantExtensionsJson: null,
      evidenceSummary: payload.evidence,
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

async function emitMissingRequiredReviewTask(args: {
  db: DrizzleClient;
  diff: { id: string; tenantId: string; merchantId: string };
  outcome: ValidationOutcome;
  categorySchemaRow: { categoryPath: string; schemaVersion: number };
}): Promise<void> {
  await args.db
    .insert(schema.reviewTasks)
    .values({
      tenantId: args.diff.tenantId,
      merchantId: args.diff.merchantId,
      proposedDiffId: args.diff.id,
      taskType: "missing_required_attribute",
      signalKind: "schema_violation",
      signalPayload: {
        categoryPath: args.categorySchemaRow.categoryPath,
        schemaVersion: args.categorySchemaRow.schemaVersion,
        missingRequired: args.outcome.missingRequired,
        validationErrors: args.outcome.errors,
        reason: `Tier 1 category ${args.categorySchemaRow.categoryPath} requires ${args.outcome.missingRequired.join(", ")} but they were not extracted`,
      },
      severity: "medium",
      policyVersionId: null,
    })
    .returning({ id: schema.reviewTasks.id });
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
  sourceFactSetId: string | null | undefined,
  payload: CanonicalProductPayload
): Promise<CanonicalProductPayload> {
  // Production: proposed_diffs.source_fact_set_id is NOT NULL via FK. Guarded
  // here so unit tests (and any edge-case caller without a fact set) skip cleanly.
  if (!sourceFactSetId) return payload;
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
      // Each fb.key maps to a compatible coerce output by construction.
      (next as unknown as Record<string, unknown>)[fb.key as string] = coerced;
      break;
    }
  }
  return next;
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
