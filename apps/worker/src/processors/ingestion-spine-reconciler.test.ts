// Verify that writeSpineExtractionToCatalog (called from runSpineLink) forwards
// the reconcilerQueue to runNewLinkCatalogPath.
//
// Strategy: inject a spy via the `_runNewLinkCatalogPath` DI hook on
// IngestionSpineProcessorDeps, then call runSpineLink with a mock adapter that
// immediately returns a successful extraction. Assert that the spy was called
// with the expected `reconcilerQueue`.
//
// The ingestion-spine package (`runIngestion`, LinkAdapter) is module-mocked
// so we never hit Redis, Playwright, or real DB.

import { describe, expect, mock, test } from "bun:test";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";

// ── Module stubs ─────────────────────────────────────────────────────────────

// Minimal fake IngestionEnvelope that satisfies the iterable shape
const FAKE_ENVELOPE: IngestionEnvelope = {
  sourceExternalId: "https://example.com/product",
} as unknown as IngestionEnvelope;

const FAKE_SKU_JSON = {
  title: "Test Product",
  description: null,
  brand: null,
  gtin: null,
  mpn: null,
  pricing: { list_price: "10.00", sale_price: null, currency: "AUD" },
  images: [],
  attributes: [],
  variants: [],
};

const FAKE_ARTIFACT_ID = "00000000-0000-0000-0000-000000000099";

const mockRunIngestion = mock(async () => ({
  status: "extracted" as const,
  skuJson: FAKE_SKU_JSON,
  artifactId: FAKE_ARTIFACT_ID,
}));

// Fake async generator that yields one envelope
async function* fakeNormalize() {
  yield FAKE_ENVELOPE;
}

const mockCreateLinkAdapterWithAntibot = mock(async () => ({
  normalize: fakeNormalize,
}));

mock.module("@aonex/ingestion-spine", () => ({
  runIngestion: mockRunIngestion,
}));

mock.module("@aonex/link-adapter", () => ({
  createLinkAdapter: mock(async () => ({ normalize: fakeNormalize })),
  createLinkAdapterWithAntibot: mockCreateLinkAdapterWithAntibot,
}));

mock.module("@aonex/catalog-source-adapters", () => ({
  channelCodeFromUrl: mock(() => "amazon-com"),
}));

// ── Test ─────────────────────────────────────────────────────────────────────

describe("ingestion-spine processor: reconcilerQueue forwarding", () => {
  test(
    "runSpineLink forwards reconcilerQueue to runNewLinkCatalogPath",
    async () => {
      const { runSpineLink } = await import("./ingestion-spine.processor.js");
      const { noopReconcilerQueues } = await import("../testing/reconciler-queue-stub.js");

      // Capture what _runNewLinkCatalogPath receives
      let capturedQueue: unknown = undefined;
      let newPathCallCount = 0;

      const stubAudit = { emit: async () => {} } as unknown as import("@aonex/audit").AuditEmitter;
      const stubDb = {
        query: {
          channels: { findFirst: async () => null },
        },
      } as unknown as import("@aonex/db").DrizzleClient;
      const stubExtractor = {} as unknown as import("@aonex/ingestion-llm-extractor").LLMProductExtractor;

      const tenantId = "tenant-spine-test" as import("@aonex/types").TenantId;

      await runSpineLink(
        {
          db: stubDb,
          audit: stubAudit,
          llmExtractor: stubExtractor,
          reconcilerQueues: noopReconcilerQueues,
          _runNewLinkCatalogPath: async (input) => {
            capturedQueue = input.reconcilerQueue;
            newPathCallCount++;
            return {
              outcome: "admitted",
              productId: "prod-spine-001",
              stagedProductId: null,
            } as import("@aonex/catalog-service").AdmitOrStageResult;
          },
        },
        {
          tenantId,
          merchantId: "merchant-001" as import("@aonex/types").MerchantId,
          lane: "link",
          sourceRef: "https://example.com/product",
          requestId: "req-spine-001",
          traceId: "trace-spine-001",
        }
      );

      expect(newPathCallCount).toBe(1);
      // The queue passed must be the one produced by noopReconcilerQueues.forTenant(tenantId)
      expect(capturedQueue).not.toBeUndefined();
      // noopReconcilerQueues.forTenant returns an object with a `name` property matching reconcilerQueueName(tenantId)
      expect((capturedQueue as { name: string }).name).toContain(tenantId);
    }
  );
});
