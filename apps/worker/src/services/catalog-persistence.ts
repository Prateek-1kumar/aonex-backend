import { eq, desc } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import { MAPPER_VERSION } from "@aonex/ingestion-semantic-mapper";
import type { ArtifactId, MerchantId, TenantId } from "@aonex/types";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { CanonicalProductPayload } from "@aonex/catalog-service";

const DEFAULT_POLICY_VERSION = "v1";

export async function getOrCreateActivePolicy(db: DrizzleClient) {
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

export async function loadMapperCorpus(db: DrizzleClient, tenantId: TenantId, merchantId: MerchantId) {
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

export async function loadRequiredAttributeKeys(
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

export async function persistExtractionRun(
  db: DrizzleClient,
  args: { artifactId: ArtifactId; tenantId: TenantId; merchantId: MerchantId; extractorVersion: string; mapperVersion: string; extractedAt: Date },
  policyVersionId: string
): Promise<string> {
  const [created] = await db
    .insert(schema.extractionRuns)
    .values({
      artifactId: args.artifactId,
      tenantId: args.tenantId,
      merchantId: args.merchantId,
      extractorVersion: args.extractorVersion,
      mapperVersion: args.mapperVersion,
      policyVersionId,
      status: "succeeded",
      startedAt: args.extractedAt,
      completedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: schema.extractionRuns.id });

  if (created) return created.id;

  const existing = await db.query.extractionRuns.findFirst({
    where: (r, { and, eq }) =>
      and(
        eq(r.artifactId, args.artifactId),
        eq(r.extractorVersion, args.extractorVersion),
        eq(r.mapperVersion, args.mapperVersion),
        eq(r.policyVersionId, policyVersionId)
      ),
  });
  if (!existing) throw new Error("Failed to persist extraction run");
  return existing.id;
}

export async function persistFactSet(
  db: DrizzleClient,
  args: { extractionRunId: string; artifactId: ArtifactId; tenantId: TenantId; merchantId: MerchantId }
): Promise<string> {
  const existing = await db.query.extractedFactSets.findFirst({
    where: (fs, { eq }) => eq(fs.extractionRunId, args.extractionRunId),
  });
  if (existing) return existing.id;

  const [created] = await db
    .insert(schema.extractedFactSets)
    .values({
      extractionRunId: args.extractionRunId,
      artifactId: args.artifactId,
      tenantId: args.tenantId,
      merchantId: args.merchantId,
    })
    .returning({ id: schema.extractedFactSets.id });

  if (!created) throw new Error("Failed to persist extracted fact set");
  return created.id;
}

export async function persistFacts(
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
      sourceAlternatives: fact.sourceAlternatives,
      approved: fact.approved,
    }))
  );
}

export async function createProposedDiff(input: {
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

export async function persistProposedDiffFields(input: {
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
