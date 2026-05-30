// Task 7.3 review fix — processor coupling test.
//
// This file is intentionally separate from link-extract-dual-write.test.ts.
//
// In Bun 1.3.x, mock.module() calls share the global module registry within
// a test run. To prevent mocks from bleeding into integration tests that rely
// on real implementations (e.g. new-catalog-link-path.test.ts), this file
// only mocks modules that are NOT used at runtime by any other test file:
//
//   @aonex/ingestion-link-fetcher   — only type-imported elsewhere
//   @aonex/ingestion-structured     — not imported by other tests
//   @aonex/ingestion-enrichment     — only type-imported elsewhere
//   ../services/link-catalog-pipeline.js — not imported by other tests
//   ../services/emit-failure-review-task.js — not imported by other tests
//   ./ingestion-spine.processor.js  — not imported by other tests
//
// Functions that ARE used at runtime by other tests are injected through the
// _channelCodeFromUrl, _resolveChannelByCode, and _runNewLinkCatalogPath
// optional dep fields added in the Option-a refactor.
//
// What this test verifies:
//   When the REAL makeLinkExtractProcessor factory runs, execution reaches
//   the new-schema write path (runNewLinkCatalogPath). The legacy path and
//   dual-write path have been removed in Phase 9.3.

import { describe, expect, mock, test } from "bun:test";

// ── Module stubs (safe — no bleed into other test files) ─────────────────────

const FAKE_FETCH_RESULT = {
  url: "https://example.com/product",
  finalUrl: "https://example.com/product",
  statusCode: 200,
  contentType: "text/html",
  fetchedAt: new Date("2026-01-01T00:00:00Z"),
  rawHtml: "<html><body>Product page</body></html>",
  cleanedText: "Product page content",
  contentChecksum: "abc123",
  structuredBlocks: [],
};

const FAKE_STRUCTURED_RESULT = {
  captchaSignal: false,
  structured: {
    facts: [
      {
        rawKey: "name",
        extractedValue: "Test Product",
        normalizedValue: "Test Product",
        sourcePointer: "h1",
        confidence: 0.9,
        extractionMethod: "structured" as const,
      },
    ],
    category: { path: null, confidence: 0 },
  },
};

const FAKE_SKU = {
  title: "Test Product",
  description: null,
  brand: null,
  gtin: null,
  mpn: null,
  pricing: { list_price: null, sale_price: null, currency: null },
  images: [],
  attributes: [],
  variants: [],
};

// Safe: only type-imported in other test files (import type { ... })
mock.module("@aonex/ingestion-link-fetcher", () => ({
  fetchLink: mock(async () => FAKE_FETCH_RESULT),
  LinkFetchError: class LinkFetchError extends Error {},
}));

// Safe: not imported by any other test file
mock.module("@aonex/ingestion-structured", () => ({
  extractStructured: mock(async () => FAKE_STRUCTURED_RESULT),
  checkCoverage: mock(() => ({ complete: true, gaps: [] })),
}));

// Safe: only type-imported in other test files (import type { ... })
mock.module("@aonex/ingestion-enrichment", () => ({
  convertFromFacts: mock(() => FAKE_SKU),
}));

// Safe: not imported by any other test file
mock.module("../services/emit-failure-review-task.js", () => ({
  emitFailureReviewTask: mock(async () => {}),
}));

// Safe: not imported by any other test file
mock.module("./ingestion-spine.processor.js", () => ({
  runSpineLink: mock(async () => {}),
}));

import { noopReconcilerQueues } from "../testing/reconciler-queue-stub.js";

// ── Test ─────────────────────────────────────────────────────────────────────

describe("link-extract processor: real factory coupling (Phase 9.3)", () => {
  test(
    "real makeLinkExtractProcessor: new-schema write path is called",
    async () => {
      // Dynamic import so the mock.module() stubs above take effect before
      // the processor's transitive deps are resolved.
      const { makeLinkExtractProcessor } = await import("./link-extract.processor.js");

      let newPathCalled = false;

      // Minimal chainable DB stub that satisfies the processor's call shapes.
      const noopUpdate = { set: () => ({ where: () => Promise.resolve([]) }) };
      const noopInsert = {
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () =>
              Promise.resolve([{ id: "00000000-0000-0000-0000-000000000001" as unknown }]),
          }),
        }),
      };
      const stubDb = {
        insert: () => noopInsert,
        update: () => noopUpdate,
        query: {
          categorySchemas: { findFirst: async () => null },
        },
      } as unknown as import("@aonex/db").DrizzleClient;

      const stubAudit = {
        emit: async () => {},
      } as unknown as import("@aonex/audit").AuditEmitter;

      const stubExtractor = {
        extract: async () => ({
          facts: [],
          modelName: "stub",
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0,
        }),
        extractGapFill: async () => ({
          facts: [],
          modelName: "stub",
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0,
        }),
      } as unknown as import("@aonex/ingestion-llm-extractor").LLMProductExtractor;

      const processor = makeLinkExtractProcessor({
        db: stubDb,
        audit: stubAudit,
        extractor: stubExtractor,
        reconcilerQueues: noopReconcilerQueues,
        // Injected stubs for functions that are used at runtime by other test
        // files — injecting avoids module-level mocking that would bleed.
        _channelCodeFromUrl: () => "unknown-channel",
        _resolveChannelByCode: async () => null,
        _runNewLinkCatalogPath: async () => {
          newPathCalled = true;
          return {
            outcome: "admitted",
            productId: "prod-001",
            stagedProductId: null,
          } as import("@aonex/catalog-service").AdmitOrStageResult;
        },
      });

      const fakeJob = {
        data: {
          tenantId: "tenant-001" as import("@aonex/types").TenantId,
          merchantId: "merchant-001" as import("@aonex/types").MerchantId,
          url: "https://example.com/product",
          requestId: "req-001",
          traceId: "trace-001",
        },
      } as unknown as import("bullmq").Job<
        import("./link-extract.processor.js").LinkExtractJobData
      >;

      // Ensure the spine env var is off — otherwise the processor shortcuts to
      // runSpineLink and never reaches the write path.
      const origSpineFlag = process.env.INGESTION_SPINE_ENABLED;
      process.env.INGESTION_SPINE_ENABLED = "false";
      try {
        await processor(fakeJob);
      } finally {
        if (origSpineFlag === undefined) delete process.env.INGESTION_SPINE_ENABLED;
        else process.env.INGESTION_SPINE_ENABLED = origSpineFlag;
      }

      expect(newPathCalled).toBe(true);
    }
  );
});
