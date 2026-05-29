// ingestion.csv_parse queue processor — takes an uploaded CSV file
// artifact, runs the CSV group adapter, writes one child source_artifact
// + catalog admit/stage per product group, and records an aggregated
// error report on the parent file artifact.

import { createHash, randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import type { DrizzleClient } from "@aonex/db";
import { schema } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import type { TenantId, MerchantId, ArtifactId } from "@aonex/types";
import { QUEUE } from "@aonex/types";
import { adaptGroups, type CsvRowIssue } from "@aonex/catalog-source-adapters";
import { eq } from "drizzle-orm";
import { resolveOrCreateCsvChannel, runNewCsvCatalogPath } from "../services/new-catalog-csv-path.js";

export interface CsvParseJobData {
  tenantId: TenantId;
  merchantId: MerchantId;
  fileArtifactId: string;
  requestId: string;
  traceId: string;
}

export interface CsvParseProcessorDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
}

interface CsvFileRaw { csv: string; filename: string; observedAt: string; }

export async function runCsvParse(deps: CsvParseProcessorDeps, data: CsvParseJobData): Promise<void> {
  const { db } = deps;
  const file = await db.query.sourceArtifacts.findFirst({
    where: (a, { eq }) => eq(a.id, data.fileArtifactId),
  });
  if (!file) throw new Error(`csv-parse: file artifact ${data.fileArtifactId} not found`);

  await db.update(schema.sourceArtifacts)
    .set({ status: "processing" })
    .where(eq(schema.sourceArtifacts.id, data.fileArtifactId));

  const raw = file.rawData as unknown as CsvFileRaw;
  const channel = await resolveOrCreateCsvChannel(db, data.tenantId);

  const { groups, errors, warnings } = adaptGroups(
    { csv: raw.csv, filename: raw.filename, observedAt: raw.observedAt },
    {
      tenantId: data.tenantId,
      channelId: channel.channelId,
      channelDefaultCurrency: channel.defaultCurrency,
      channelDefaultLocale: channel.defaultLocale,
      attributeDefinitions: [],
      attributeSynonyms: [],
    },
  );

  const issues: CsvRowIssue[] = [...errors, ...warnings];
  let admittedCount = 0;

  for (const group of groups) {
    try {
      const childId = randomUUID();
      const groupChecksum = createHash("sha256")
        .update(JSON.stringify(group.output.rawPayload))
        .digest("hex");
      const inserted = await db.insert(schema.sourceArtifacts).values({
        id: childId,
        tenantId: data.tenantId,
        merchantId: data.merchantId,
        sourceType: "templated_csv",
        sourceMarketplace: null,
        sourceExternalId: group.primaryIdentifier,
        parentArtifactId: data.fileArtifactId,
        rawData: { rows: group.output.rawPayload },
        checksum: groupChecksum,
        status: "processing",
      }).onConflictDoNothing().returning({ id: schema.sourceArtifacts.id });

      // Duplicate group (already ingested in a prior upload) — skip the write.
      if (inserted.length === 0) continue;
      const artifactId = (inserted[0]!.id) as ArtifactId;

      await runNewCsvCatalogPath({
        db,
        tenantId: data.tenantId,
        merchantId: data.merchantId,
        artifactId,
        adapterOutput: group.output,
        channel: { channelId: channel.channelId },
      });
      await db.update(schema.sourceArtifacts).set({ status: "completed" })
        .where(eq(schema.sourceArtifacts.id, artifactId as string));
      admittedCount += 1;
    } catch (err) {
      issues.push({
        row: group.rowIndices[0] ?? 0,
        code: "CATALOG_WRITE_FAILED",
        message: err instanceof Error ? err.message : String(err),
        primaryIdentifier: group.primaryIdentifier,
      });
    }
  }

  const hardErrors = issues.filter((i) => i.code !== "UNKNOWN_COLUMN");
  const status = admittedCount === 0
    ? "failed"
    : hardErrors.length > 0 ? "needs_review" : "completed";

  await db.update(schema.sourceArtifacts)
    .set({ status, processingErrors: issues as unknown as Record<string, unknown>[] })
    .where(eq(schema.sourceArtifacts.id, data.fileArtifactId));

  await deps.audit.emit({
    tenantId: data.tenantId,
    merchantId: data.merchantId,
    actorType: "worker",
    eventType: "ingestion.csv_parsed",
    entityType: "source_artifact",
    entityId: data.fileArtifactId,
    requestId: data.requestId,
    metadata: { admittedCount, errorCount: hardErrors.length, warningCount: warnings.length, status },
  });
}

export function makeCsvParseProcessor(deps: CsvParseProcessorDeps) {
  return async (job: Job<CsvParseJobData>): Promise<void> => {
    await runCsvParse(deps, job.data);
  };
}

export const PROCESSOR_QUEUE = QUEUE.CSV_PARSE;
