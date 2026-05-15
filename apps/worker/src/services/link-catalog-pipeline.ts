import { eq, desc } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { map, MAPPER_VERSION } from "@aonex/ingestion-semantic-mapper";
import { route, clusterKey } from "@aonex/ingestion-policy-engine";
import type { PolicyInputs, RouterInput } from "@aonex/ingestion-policy-engine";
import { domainOf } from "@aonex/lib-utils";
import { normalizeAxisName, normalizeAxisValue, checkVariantMatrix } from "@aonex/ingestion-variant-extractor";
import { applyApprovedDiff, type CanonicalProductPayload } from "@aonex/catalog-service";
import type { ExtractedFactSet, ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ArtifactId, MerchantId, TenantId } from "@aonex/types";

const DEFAULT_POLICY_VERSION = "v1";

const CORE_FIELD_MAP: Record<string, string> = {
  title: "title",
  brand: "brand",
  vendor: "brand",
  gtin: "gtin",
  barcode: "gtin",
  model_number: "modelNumber",
  modelNumber: "modelNumber",
  mpn: "modelNumber",
  description: "description",
  base_price: "basePrice",
  price: "basePrice",
  currency: "currency",
  category_path: "canonicalCategory",
  productType: "canonicalCategory",
  images: "images",
};

export interface PersistLinkCatalogInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  artifactId: ArtifactId;
  sourceUrl: string;
  factSet: ExtractedFactSet;
  suggestedCategory: string | null;
  categoryConfidence: number;
  extractorMeta: {
    modelName: string | null;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
  };
  /** Real dedup decision (no longer hardcoded). */
  dedupeDecision: PolicyInputs["dedupeDecision"];
  /** Per-domain reliability from domain_profiles (no longer hardcoded 0.65). */
  sourceReliability: number;
}

export interface PersistLinkCatalogResult {
  extractionRunId: string;
  factSetId: string;
  proposedDiffId: string | null;
  route: "auto_approve" | "review";
  confidenceScore: number;
  productId?: string;
  productVersionId?: string;
}

async function buildRouterInput(args: {
  db: DrizzleClient;
  tenantId: TenantId;
  facts: ExtractedFact[];
  payload: CanonicalProductPayload;
  domain: string;
  category: { path: string | null; confidence: number };
  categoryRequiredAttributes: string[];
}): Promise<RouterInput> {
  const identityIndex: RouterInput["identityIndex"] = {};

  // Helper: look up an identity row + its product's latest version
  async function lookupIdentity(
    identityType: "gtin" | "mpn",
    identityValue: string
  ): Promise<RouterInput["identityIndex"]["gtin"] | undefined> {
    const row = await args.db.query.productIdentities.findFirst({
      where: (i, { and, eq }) =>
        and(
          eq(i.tenantId, args.tenantId),
          eq(i.identityType, identityType),
          eq(i.identityValue, identityValue)
        ),
    });
    if (!row) return undefined;
    const pv = await args.db.query.productVersions.findFirst({
      where: (v, { eq }) => eq(v.productId, row.productId),
      orderBy: (v, { desc }) => [desc(v.createdAt)],
    });
    return {
      productId: row.productId,
      brand: pv?.brand ?? null,
      // product_versions uses `canonicalCategory` column
      canonicalCategory: pv?.canonicalCategory ?? null,
    };
  }

  if (args.payload.gtin) {
    const gtinHit = await lookupIdentity("gtin", args.payload.gtin);
    if (gtinHit) identityIndex.gtin = gtinHit;
  }
  // CanonicalProductPayload uses `modelNumber` (mapped from mpn/model_number)
  if (args.payload.modelNumber) {
    const mpnHit = await lookupIdentity("mpn", args.payload.modelNumber);
    if (mpnHit) identityIndex.mpn = mpnHit;
  }

  // priceCluster
  let priceCluster: RouterInput["priceCluster"] = null;
  if (args.payload.brand && args.payload.canonicalCategory && args.payload.currency) {
    const cluster = await args.db.query.priceClusters.findFirst({
      where: (c, { and, eq }) =>
        and(
          eq(c.tenantId, args.tenantId),
          eq(c.brand, args.payload.brand!),
          eq(c.canonicalCategory, args.payload.canonicalCategory!),
          eq(c.currency, args.payload.currency!)
        ),
    });
    if (cluster) {
      priceCluster = {
        medianPrice: Number(cluster.medianPrice),
        sampleCount: cluster.sampleCount,
      };
    }
  }

  // Normalize axis names + values so detectors see consistent shape.
  const normalizedVariants: Array<{ optionValues: Record<string, string> }> = [];
  const variantAxes: Record<string, string[]> = {};
  for (const v of args.payload.variants) {
    const normalizedOV: Record<string, string> = {};
    for (const [axis, value] of Object.entries(v.optionValues ?? {})) {
      if (typeof value !== "string") continue;
      const normAxis = normalizeAxisName(axis);
      const normValue = normalizeAxisValue(normAxis, value);
      if (!normValue) continue;
      normalizedOV[normAxis] = normValue;
      const set = (variantAxes[normAxis] ??= []);
      if (!set.includes(normValue)) set.push(normValue);
    }
    normalizedVariants.push({ optionValues: normalizedOV });
  }

  // Sanity check the matrix (exposed via console / future telemetry, not currently in RouterInput).
  const matrix = checkVariantMatrix({ variants: normalizedVariants, axes: variantAxes });
  if (!matrix.complete && matrix.expected > 0) {
    // The variant_incomplete detector independently catches this with the same logic.
    // Logging here helps with operational visibility.
    console.debug(
      `[router-input] variant matrix incomplete: ${matrix.actual}/${matrix.expected}`,
      { domain: args.domain, axes: variantAxes }
    );
  }

  return {
    facts: args.facts,
    payload: {
      title: args.payload.title,
      brand: args.payload.brand,
      gtin: args.payload.gtin,
      // CanonicalProductPayload uses `modelNumber` (not `mpn`)
      modelNumber: args.payload.modelNumber,
      // CanonicalProductPayload uses `basePrice` (not `price`)
      basePrice: args.payload.basePrice,
      currency: args.payload.currency,
      canonicalCategory: args.payload.canonicalCategory,
      // variants have `optionValues` (Record<string,string>), `sku`, `price`
      variants: args.payload.variants.map((v) => ({
        optionValues: v.optionValues ?? {},
        sku: v.sku ?? null,
        price: v.price ?? null,
      })),
    },
    domain: args.domain,
    category: args.category,
    categoryRequiredAttributes: args.categoryRequiredAttributes,
    identityIndex,
    priceCluster,
    variantAxes,
  };
}

export async function persistLinkCatalogPipeline(
  input: PersistLinkCatalogInput
): Promise<PersistLinkCatalogResult> {
  const policy = await getOrCreateActivePolicy(input.db);
  const corpus = await loadMapperCorpus(input.db, input.tenantId, input.merchantId);
  const mappedFactSet = map(input.factSet, input.suggestedCategory, corpus);
  const canonicalFacts = mappedFactSet.facts.map(withFallbackCanonicalPath);

  const extractionRunId = await persistExtractionRun(input, policy.id);
  const factSetId = await persistFactSet(input, extractionRunId);
  await persistFacts(input.db, input.tenantId, factSetId, canonicalFacts);

  const canonicalPayload = buildCanonicalPayload({
    facts: canonicalFacts,
    sourceUrl: input.sourceUrl,
    artifactId: input.artifactId,
    suggestedCategory: input.suggestedCategory,
    categoryConfidence: input.categoryConfidence,
    mapperVersion: MAPPER_VERSION,
    extractorVersion: input.factSet.extractorVersion,
    extractorMeta: input.extractorMeta,
  });

  const routerInput = await buildRouterInput({
    db: input.db,
    tenantId: input.tenantId,
    facts: canonicalFacts,
    payload: canonicalPayload,
    domain: domainOf(input.sourceUrl),
    category: { path: input.suggestedCategory, confidence: input.categoryConfidence },
    categoryRequiredAttributes: await loadRequiredAttributeKeys(input.db, input.suggestedCategory),
  });

  const decision = route(routerInput);

  const shouldAutoApprove = decision.route === "auto_approve" && Boolean(canonicalPayload.title);
  const proposedDiff = await createProposedDiff({
    db: input.db,
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    factSetId,
    policyVersionId: policy.id,
    confidenceScore: decision.score,
    status: shouldAutoApprove ? "auto_approved" : "open",
    payload: {
      ...canonicalPayload,
      policyEvidence: decision.evidence,
    },
  });

  if (!proposedDiff.created) {
    return {
      extractionRunId,
      factSetId,
      proposedDiffId: proposedDiff.id,
      route: shouldAutoApprove ? "auto_approve" : "review",
      confidenceScore: decision.score,
    };
  }

  await persistProposedDiffFields({
    db: input.db,
    diffId: proposedDiff.id,
    payload: canonicalPayload,
    facts: canonicalFacts,
  });

  if (shouldAutoApprove) {
    const applied = await applyApprovedDiff({
      db: input.db,
      diffId: proposedDiff.id,
      approvalStatus: "auto_approved",
    });
    return {
      extractionRunId,
      factSetId,
      proposedDiffId: proposedDiff.id,
      route: "auto_approve",
      confidenceScore: decision.score,
      productId: applied.productId,
      productVersionId: applied.productVersionId,
    };
  }

  for (const signal of decision.reviewTasks) {
    await input.db.insert(schema.reviewTasks).values({
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      proposedDiffId: proposedDiff.id,
      artifactId: input.artifactId,
      taskType: signal.signalKind,           // dual-write to legacy column
      signalKind: signal.signalKind,
      signalPayload: signal.payload as Record<string, unknown>,
      clusterKey: clusterKey(signal),
      fieldName: signal.fieldName ?? null,
      severity: signal.severity,
      policyVersionId: policy.id,
    });
  }

  return {
    extractionRunId,
    factSetId,
    proposedDiffId: proposedDiff.id,
    route: "review",
    confidenceScore: decision.score,
  };
}

async function getOrCreateActivePolicy(db: DrizzleClient) {
  const active = await db.query.policyVersions.findFirst({
    where: (p, { eq }) => eq(p.active, true),
  });
  if (active) return active;

  const [created] = await db
    .insert(schema.policyVersions)
    .values({
      version: DEFAULT_POLICY_VERSION,
      active: true,
      scoringWeights: {
        identity: 0.4,
        category: 0.15,
        fieldMapping: 0.15,
        variant: 0.1,
        schema: 0.1,
        media: 0.05,
        sourceReliability: 0.05,
      },
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  const fallback = await db.query.policyVersions.findFirst({
    orderBy: (p, { desc }) => [desc(p.createdAt)],
  });
  if (!fallback) throw new Error("No policy version available");
  return fallback;
}

async function loadMapperCorpus(db: DrizzleClient, tenantId: TenantId, merchantId: MerchantId) {
  const [knownAttrs, synonyms, channelMappings, overrides] = await Promise.all([
    db.select().from(schema.attributeDefinitions),
    db.select().from(schema.attributeSynonyms),
    db.select().from(schema.attributeMappings),
    db
      .select()
      .from(schema.mappingOverrides)
      .where(eq(schema.mappingOverrides.tenantId, tenantId)),
  ]);

  return {
    knownAttrs,
    synonyms,
    channelMappings,
    overrides: overrides.filter((o) => !o.merchantId || o.merchantId === merchantId),
  };
}

async function loadRequiredAttributeKeys(
  db: DrizzleClient,
  categoryPath: string | null
): Promise<string[]> {
  if (!categoryPath) return [];
  const row = await db.query.categorySchemas.findFirst({
    where: (c, { eq }) => eq(c.categoryPath, categoryPath),
    orderBy: (c, { desc }) => [desc(c.schemaVersion)],
  });
  return row?.requiredAttributes ?? [];
}

async function persistExtractionRun(
  input: PersistLinkCatalogInput,
  policyVersionId: string
): Promise<string> {
  const [created] = await input.db
    .insert(schema.extractionRuns)
    .values({
      artifactId: input.artifactId,
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      extractorVersion: input.factSet.extractorVersion,
      mapperVersion: MAPPER_VERSION,
      policyVersionId,
      status: "succeeded",
      startedAt: input.factSet.extractedAt,
      completedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: schema.extractionRuns.id });

  if (created) return created.id;

  const existing = await input.db.query.extractionRuns.findFirst({
    where: (r, { and, eq }) =>
      and(
        eq(r.artifactId, input.artifactId),
        eq(r.extractorVersion, input.factSet.extractorVersion),
        eq(r.mapperVersion, MAPPER_VERSION),
        eq(r.policyVersionId, policyVersionId)
      ),
  });
  if (!existing) throw new Error("Failed to persist extraction run");
  return existing.id;
}

async function persistFactSet(
  input: PersistLinkCatalogInput,
  extractionRunId: string
): Promise<string> {
  const existing = await input.db.query.extractedFactSets.findFirst({
    where: (fs, { eq }) => eq(fs.extractionRunId, extractionRunId),
  });
  if (existing) return existing.id;

  const [created] = await input.db
    .insert(schema.extractedFactSets)
    .values({
      extractionRunId,
      artifactId: input.artifactId,
      tenantId: input.tenantId,
      merchantId: input.merchantId,
    })
    .returning({ id: schema.extractedFactSets.id });

  if (!created) throw new Error("Failed to persist extracted fact set");
  return created.id;
}

async function persistFacts(
  db: DrizzleClient,
  tenantId: TenantId,
  factSetId: string,
  facts: ExtractedFact[]
): Promise<void> {
  const existing = await db.query.extractedFacts.findFirst({
    where: (f, { eq }) => eq(f.factSetId, factSetId),
  });
  if (existing || facts.length === 0) return;

  await db.insert(schema.extractedFacts).values(
    facts.map((fact) => ({
      factSetId,
      tenantId,
      rawKey: fact.rawKey,
      canonicalPath: fact.canonicalPath,
      extractedValue: fact.extractedValue,
      normalizedValue: fact.normalizedValue,
      unit: fact.unit,
      sourcePointer: fact.sourcePointer,
      extractionMethod: fact.extractionMethod,
      confidence: String(Math.max(0, Math.min(1, fact.confidence))),
      mappingMethod: fact.mappingMethod,
      mappingCandidates: fact.mappingCandidates,
      approved: fact.approved,
    }))
  );
}

async function createProposedDiff(input: {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  factSetId: string;
  policyVersionId: string;
  confidenceScore: number;
  status: "open" | "auto_approved";
  payload: Record<string, unknown>;
}): Promise<{ id: string; created: boolean }> {
  const [created] = await input.db
    .insert(schema.proposedDiffs)
    .values({
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      sourceFactSetId: input.factSetId,
      diffType: "create",
      status: input.status,
      policyVersionId: input.policyVersionId,
      confidenceScore: String(input.confidenceScore),
      actorType: input.status === "auto_approved" ? "policy" : "system",
      diffPayload: input.payload,
    })
    .onConflictDoNothing()
    .returning({ id: schema.proposedDiffs.id });

  if (created) return { id: created.id, created: true };

  const existing = await input.db.query.proposedDiffs.findFirst({
    where: (d, { and, eq }) =>
      and(eq(d.sourceFactSetId, input.factSetId), eq(d.diffType, "create")),
  });
  if (!existing) throw new Error("Failed to persist proposed diff");
  return { id: existing.id, created: false };
}

async function persistProposedDiffFields(input: {
  db: DrizzleClient;
  diffId: string;
  payload: CanonicalProductPayload;
  facts: ExtractedFact[];
}): Promise<void> {
  const factConfidence = new Map<string, number>();
  for (const fact of input.facts) {
    const key = fact.canonicalPath ?? fact.rawKey;
    factConfidence.set(key, Math.max(factConfidence.get(key) ?? 0, fact.confidence));
  }

  const fields: Array<{ fieldName: string; newValue: unknown; confidence: string; isAutoApproved: boolean }> = [];
  for (const [fieldName, newValue] of Object.entries({
    title: input.payload.title,
    brand: input.payload.brand,
    gtin: input.payload.gtin,
    modelNumber: input.payload.modelNumber,
    description: input.payload.description,
    basePrice: input.payload.basePrice,
    currency: input.payload.currency,
    canonicalCategory: input.payload.canonicalCategory,
    images: input.payload.images,
    attributes: input.payload.attributes,
    variants: input.payload.variants,
  })) {
    if (newValue == null) continue;
    const confidence = factConfidence.get(fieldName) ?? 0.6;
    fields.push({
      fieldName,
      newValue,
      confidence: String(confidence),
      isAutoApproved: confidence >= 0.9,
    });
  }

  if (fields.length === 0) return;
  await input.db.insert(schema.proposedDiffFields).values(
    fields.map((field) => ({
      diffId: input.diffId,
      fieldName: field.fieldName,
      newValue: field.newValue,
      confidence: field.confidence,
      isAutoApproved: field.isAutoApproved,
    }))
  );
}

function withFallbackCanonicalPath(fact: ExtractedFact): ExtractedFact {
  const fallback = CORE_FIELD_MAP[fact.rawKey];
  if (!fallback || fact.canonicalPath) return fact;
  return {
    ...fact,
    canonicalPath: fallback,
    mappingMethod: fact.mappingMethod ?? "link_core_field",
    mappingCandidates: fact.mappingCandidates ?? [{ key: fallback, score: 0.95 }],
    approved: fact.confidence >= 0.85,
  };
}

function buildCanonicalPayload(input: {
  facts: ExtractedFact[];
  sourceUrl: string;
  artifactId: ArtifactId;
  suggestedCategory: string | null;
  categoryConfidence: number;
  mapperVersion: string;
  extractorVersion: string;
  extractorMeta: PersistLinkCatalogInput["extractorMeta"];
}): CanonicalProductPayload {
  const best = new Map<string, ExtractedFact>();
  for (const fact of input.facts) {
    const key = fact.canonicalPath ?? fact.rawKey;
    const previous = best.get(key);
    if (!previous || fact.confidence > previous.confidence) best.set(key, fact);
  }

  const attributes: Record<string, unknown> = {};
  for (const fact of input.facts) {
    const key = fact.canonicalPath ?? fact.rawKey;
    if (Object.values(CORE_FIELD_MAP).includes(key)) continue;
    if (key.startsWith("variants[")) continue;
    attributes[key] = fact.normalizedValue ?? fact.extractedValue;
  }

  return {
    title: stringValue(best.get("title")),
    brand: stringValue(best.get("brand")),
    gtin: stringValue(best.get("gtin")),
    modelNumber: stringValue(best.get("modelNumber")),
    description: stringValue(best.get("description")),
    basePrice: numberValue(best.get("basePrice")),
    currency: stringValue(best.get("currency"))?.toUpperCase() ?? null,
    canonicalCategory:
      stringValue(best.get("canonicalCategory")) ?? input.suggestedCategory,
    images: imageValue(best.get("images")),
    attributes,
    variants: variantValue(input.facts, stringValue(best.get("currency"))),
    evidence: {
      sourceUrl: input.sourceUrl,
      artifactId: input.artifactId,
      categoryConfidence: input.categoryConfidence,
      extractorVersion: input.extractorVersion,
      mapperVersion: input.mapperVersion,
      modelName: input.extractorMeta.modelName,
      promptTokens: input.extractorMeta.promptTokens,
      completionTokens: input.extractorMeta.completionTokens,
      estimatedCostUsd: input.extractorMeta.estimatedCostUsd,
    },
  };
}

function stringValue(fact: ExtractedFact | undefined): string | null {
  const value = fact?.normalizedValue ?? fact?.extractedValue;
  if (value == null) return null;
  const str = String(value).trim();
  return str ? str : null;
}

function numberValue(fact: ExtractedFact | undefined): number | null {
  const value = fact?.normalizedValue ?? fact?.extractedValue;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function imageValue(fact: ExtractedFact | undefined): Array<{ url: string; altText?: string }> {
  const value = fact?.normalizedValue ?? fact?.extractedValue;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.url !== "string") return [];
    const image: { url: string; altText?: string } = { url: item.url };
    if (typeof item.altText === "string" && item.altText.trim()) {
      image.altText = item.altText;
    }
    return [image];
  });
}

function variantValue(facts: ExtractedFact[], fallbackCurrency: string | null) {
  const variants = new Map<number, Record<string, unknown>>();
  for (const fact of facts) {
    const match = /^variants\[(\d+)\]\.(.+)$/.exec(fact.rawKey);
    if (!match) continue;
    const [, indexRaw, field] = match;
    if (!indexRaw || !field) continue;
    const index = Number(indexRaw);
    const record = variants.get(index) ?? { optionValues: {} };
    if (field.startsWith("option.")) {
      const optionName = field.replace("option.", "");
      const options = isRecord(record.optionValues) ? record.optionValues : {};
      options[optionName] = String(fact.normalizedValue ?? fact.extractedValue);
      record.optionValues = options;
    } else {
      record[field] = fact.normalizedValue ?? fact.extractedValue;
    }
    variants.set(index, record);
  }

  return Array.from(variants.values()).map((record) => ({
    sku: typeof record.sku === "string" ? record.sku : null,
    barcode: typeof record.barcode === "string" ? record.barcode : null,
    price: typeof record.price === "number" ? record.price : numberFromUnknown(record.price),
    currency: fallbackCurrency,
    inventoryQuantity: numberFromUnknown(record.inventory_quantity),
    optionValues: isRecord(record.optionValues)
      ? Object.fromEntries(
          Object.entries(record.optionValues).map(([key, value]) => [key, String(value)])
        )
      : {},
  }));
}

function numberFromUnknown(value: unknown): number | null {
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
