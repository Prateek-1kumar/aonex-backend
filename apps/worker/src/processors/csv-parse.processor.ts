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
import { ReconcilerQueueProvider } from "../services/reconciler-queue-provider.js";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  reconcilerQueues: ReconcilerQueueProvider;
}

interface CsvFileRaw {
  csv?: string;
  fileBase64?: string;
  filename: string;
  observedAt: string;
  fileType?: string;
}

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

  let resolvedCsv = "";

  if (raw.fileBase64) {
    const tempDir = await mkdtemp(join(tmpdir(), "aonex-ingest-"));
    try {
      const fileExt = raw.fileType === "xlsx" ? ".xlsx" : ".numbers";
      const tempFilePath = join(tempDir, `upload${fileExt}`);
      const extractedImagesDir = join(tempDir, "extracted_images");

      await writeFile(tempFilePath, Buffer.from(raw.fileBase64, "base64"));

      const pythonExe = "/Users/prateekkumar/aonex/aonex-backend/scratch/venv/bin/python";
      const scriptPath = "/Users/prateekkumar/aonex/aonex-backend/scratch/parse_spreadsheet.py";

      const { stdout, stderr } = await execFileAsync(pythonExe, [
        scriptPath,
        "--file", tempFilePath,
        "--out-dir", extractedImagesDir
      ]);

      if (stderr) {
        console.warn("[csv-parse] spreadsheet parser stderr:", stderr);
      }

      let csvText = stdout;
      // Convert any absolute paths of extracted images inside the temp folder to base64 data URLs
      const escapedDir = extractedImagesDir.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
      const pathRegex = new RegExp(`${escapedDir}[^"\\n,]+`, "g");
      const matches = Array.from(csvText.matchAll(pathRegex)).map((m) => m[0]);
      const uniqueMatches = Array.from(new Set(matches));

      for (const localPath of uniqueMatches) {
        try {
          const buffer = await readFile(localPath);
          const ext = localPath.split(".").pop()?.toLowerCase();
          const mime = ext === "png" ? "image/png" : "image/jpeg";
          const base64Url = `data:${mime};base64,${buffer.toString("base64")}`;
          csvText = csvText.replaceAll(localPath, base64Url);
        } catch (err) {
          console.warn(`[csv-parse] Failed to convert local image ${localPath}:`, err);
        }
      }

      resolvedCsv = csvText;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } else {
    resolvedCsv = raw.csv ?? "";
  }

  const { groups, errors, warnings } = adaptGroups(
    { csv: resolvedCsv, filename: raw.filename, observedAt: raw.observedAt },
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
  let processedCount = 0;

  for (const group of groups) {
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

    try {
      const pathResult = await runNewCsvCatalogPath({
        db,
        tenantId: data.tenantId,
        merchantId: data.merchantId,
        artifactId,
        adapterOutput: group.output,
        channel: { channelId: channel.channelId },
        reconcilerQueue: deps.reconcilerQueues.forTenant(data.tenantId),
      });

      const childStatus = pathResult.outcome === "staged" ? "needs_review" : "completed";
      await db.update(schema.sourceArtifacts).set({
        status: childStatus,
        rawData: {
          rows: group.output.rawPayload,
          outcome: pathResult.outcome,
          productId: pathResult.productId,
          stagedProductId: pathResult.stagedProductId,
        }
      })
      .where(eq(schema.sourceArtifacts.id, artifactId as string));

      processedCount += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.update(schema.sourceArtifacts)
        .set({ status: "failed", processingErrors: [{ step: "catalog_write", error: message }] as unknown as Record<string, unknown>[] })
        .where(eq(schema.sourceArtifacts.id, artifactId as string));
      issues.push({
        row: group.rowIndices[0] ?? 0,
        code: "CATALOG_WRITE_FAILED",
        message,
        primaryIdentifier: group.primaryIdentifier,
      });
    }
  }

  const hardErrors = issues.filter((i) => i.code !== "UNKNOWN_COLUMN");
  const status = processedCount === 0
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
    metadata: { processedCount, errorCount: hardErrors.length, warningCount: warnings.length, status },
  });
}

export function makeCsvParseProcessor(deps: CsvParseProcessorDeps) {
  return async (job: Job<CsvParseJobData>): Promise<void> => {
    await runCsvParse(deps, job.data);
  };
}

export const PROCESSOR_QUEUE = QUEUE.CSV_PARSE;
