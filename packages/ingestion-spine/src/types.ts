import type { TenantId, MerchantId, ArtifactId, Marketplace } from "@aonex/types";

export type IngestionLane = "link" | "csv" | "nango";

export type StageName =
  | "persist_artifact"
  | "extract"
  | "map"
  | "validate"
  | "score"
  | "diff"
  | "approve";

export interface StageAuditMeta {
  tenantId: TenantId;
  merchantId: MerchantId;
  artifactId: ArtifactId | null;
  extractionRunId: string | null;
  factSetId: string | null;
  productId: string | null;
  productVersionId: string | null;
  proposedDiffId: string | null;
  requestId: string;
  traceId: string;
  lane: IngestionLane;
  extractorVersion: string;
  mapperVersion: string;
  policyVersion: string;
}

export interface ExtractionHints {
  categoryHint?: string;
  regionHint?: string;
  localeHint?: string;
  perSiteParserHint?: string;
}

export interface IngestionEnvelope {
  /** Stable external ID — URL for link, row-id for CSV, marketplace SKU for Nango. */
  sourceExternalId: string;
  /** Lane-specific source type for source_artifacts. */
  sourceType: "link_url" | "templated_csv" | "marketplace_connector";
  sourceMarketplace: Marketplace | null;
  /** Raw record. For link: HTML + structured blocks. For CSV: parsed row. For Nango: raw payload. */
  rawData: Record<string, unknown>;
  /** SHA-256 hex of canonicalStringify(rawData). */
  checksum: string;
  parentArtifactId?: ArtifactId;
  extractionHints?: ExtractionHints;
  /** Object-storage URI for large raw evidence (full HTML, CSV file). */
  storageUri?: string;
}
