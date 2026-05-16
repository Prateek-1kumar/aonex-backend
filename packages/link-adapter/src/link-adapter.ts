import type { IngestionAdapter, IngestionEnvelope } from "@aonex/ingestion-spine";
import { fetchLink, type LinkFetchResult } from "@aonex/ingestion-link-fetcher";
import { extractStructured } from "@aonex/ingestion-structured";
import { LLMProductExtractor, LLM_EXTRACTOR_VERSION } from "@aonex/ingestion-llm-extractor";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

// Local AdapterInput definition — AdapterInput is intentionally internal to
// @aonex/ingestion-spine (Task 3 contract) and is NOT re-exported from its index.
interface AdapterInput {
  /** Single URL for LinkAdapter. */
  sourceRef: string;
  /** Optional hints passed by the API caller (categoryHint, etc.). */
  hints?: { categoryHint?: string; localeHint?: string };
}

export interface LinkAdapterDeps {
  fetcher?: typeof fetchLink;
  llmExtractor: LLMProductExtractor;
}

class LinkAdapter implements IngestionAdapter {
  readonly lane = "link" as const;
  private readonly deps: Required<LinkAdapterDeps>;
  /**
   * Cache fetcher result between normalize() and extract() so we don't re-fetch.
   * Lifetime = one adapter instance = one job.
   */
  private fetchCache = new Map<string, LinkFetchResult>();

  constructor(deps: LinkAdapterDeps) {
    this.deps = { fetcher: deps.fetcher ?? fetchLink, llmExtractor: deps.llmExtractor };
  }

  async *normalize(input: AdapterInput): AsyncIterable<IngestionEnvelope> {
    const result = await this.deps.fetcher(input.sourceRef);
    this.fetchCache.set(input.sourceRef, result);

    const hints = input.hints;
    yield {
      sourceExternalId: result.finalUrl,
      sourceType: "link_url",
      sourceMarketplace: null,
      rawData: {
        url: result.url,
        finalUrl: result.finalUrl,
        statusCode: result.statusCode,
        contentType: result.contentType,
        fetchedAt: result.fetchedAt.toISOString(),
        htmlSnippet: result.rawHtml.substring(0, 10_000),
        cleanedTextLength: result.cleanedText.length
      },
      checksum: result.contentChecksum,
      // exactOptionalPropertyTypes: spread the key in only when there are hints
      // so we never set extractionHints to undefined explicitly.
      ...(hints !== undefined
        ? {
            extractionHints: {
              ...(hints.categoryHint !== undefined ? { categoryHint: hints.categoryHint } : {}),
              ...(hints.localeHint !== undefined ? { localeHint: hints.localeHint } : {})
            }
          }
        : {})
    };
  }

  async extract(envelope: IngestionEnvelope): Promise<ExtractedFactSet> {
    const fetchResult = this.fetchCache.get(envelope.sourceExternalId);
    if (!fetchResult) {
      // Re-fetch as fallback (shouldn't normally happen — cache is per-instance/per-job —
      // but keeps the contract honest when extract() is called on a cold adapter).
      const result = await this.deps.fetcher(envelope.sourceExternalId);
      this.fetchCache.set(envelope.sourceExternalId, result);
      return this.extract(envelope);
    }

    const structured = await extractStructured({
      pageUrl: fetchResult.finalUrl,
      rawHtml: fetchResult.rawHtml,
      structuredBlocks: fetchResult.structuredBlocks
    });

    const llmFacts: ExtractedFactSet["facts"] = [];
    if (structured.structured.facts.length === 0) {
      const r = await this.deps.llmExtractor.extract(
        fetchResult.cleanedText,
        fetchResult.finalUrl,
        envelope.sourceExternalId as never
      );
      llmFacts.push(...r.facts);
    }

    return {
      artifactId: envelope.sourceExternalId as never, // will be re-tagged by runExtract
      marketplace: "link_url",
      extractorVersion: LLM_EXTRACTOR_VERSION,
      facts: [...structured.structured.facts, ...llmFacts],
      extractedAt: new Date()
    };
  }
}

export function createLinkAdapter(deps: LinkAdapterDeps): IngestionAdapter {
  return new LinkAdapter(deps);
}

export { LinkAdapter };
