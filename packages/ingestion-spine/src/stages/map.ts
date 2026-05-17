import { map as semanticMap, type MapperCorpus, type MappedFactSet } from "@aonex/ingestion-semantic-mapper";
import type { DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId } from "@aonex/types";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";
import { schema } from "@aonex/db";
import { eq } from "drizzle-orm";

export interface RunMapInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  factSet: ExtractedFactSet;
  categoryHint: string | null;
}

export async function runMap(input: RunMapInput): Promise<MappedFactSet> {
  const corpus = await loadMapperCorpus(input.db, input.tenantId, input.merchantId);
  return semanticMap(input.factSet, input.categoryHint, corpus);
}

async function loadMapperCorpus(
  db: DrizzleClient,
  tenantId: TenantId,
  merchantId: MerchantId
): Promise<MapperCorpus> {
  const [knownAttrs, synonyms, channelMappings, overrides] = await Promise.all([
    db.select().from(schema.attributeDefinitions),
    db.select().from(schema.attributeSynonyms),
    db.select().from(schema.attributeMappings),
    db.select().from(schema.mappingOverrides).where(eq(schema.mappingOverrides.tenantId, tenantId))
  ]);
  return {
    knownAttrs,
    synonyms,
    channelMappings,
    overrides: overrides.filter((o) => !o.merchantId || o.merchantId === merchantId)
  };
}
