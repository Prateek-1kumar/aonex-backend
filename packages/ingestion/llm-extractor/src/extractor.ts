// LLM Extractor — orchestrates the full extraction flow:
//   cleaned HTML text → prompt builder → model provider → response parser
//
// This is the main entry point for LLM-based product extraction.
// It produces an ExtractedFactSet compatible with the existing
// semantic mapper pipeline.
//
// HLD §22.3: Model output becomes extracted facts, never direct writes.
// HLD §4: "Make risky autonomy explicit."

import type { ArtifactId } from "@aonex/types";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";
import type { IModelProvider } from "./providers/types.js";
import { buildExtractionPrompt } from "./prompt-builder.js";
import { parseLLMResponse, convertToExtractedFacts } from "./response-parser.js";
import {
  type LLMExtractionOptions,
  type LLMExtractionResult,
  type PromptBuildParams,
  LLM_EXTRACTOR_VERSION,
  DEFAULT_LLM_OPTIONS,
} from "./types.js";

export class LLMProductExtractor {
  private readonly provider: IModelProvider;

  constructor(provider: IModelProvider) {
    this.provider = provider;
  }

  /**
   * Extract product data from cleaned HTML text using an LLM.
   *
   * @param cleanedText - HTML content with scripts/styles stripped (from link-fetcher)
   * @param url - Original source URL for provenance tracking
   * @param artifactId - The source_artifact.id for this extraction
   * @param options - Model and extraction configuration
   * @returns Extracted facts + metadata (cost, tokens, category)
   * @throws On LLM API errors or completely invalid responses
   */
  async extract(
    cleanedText: string,
    url: string,
    artifactId: ArtifactId,
    options?: LLMExtractionOptions
  ): Promise<LLMExtractionResult> {
    const opts = { ...DEFAULT_LLM_OPTIONS, ...options };

    // Build the prompt messages
    const promptParams: PromptBuildParams = {
      cleanedText,
      url,
      ...(opts.categoryHint ? { categoryHint: opts.categoryHint } : {}),
    };
    const messages = buildExtractionPrompt(promptParams);

    // Call the LLM
    const completion = await this.provider.chatCompletion({
      model: opts.model,
      messages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      jsonMode: true,
    });

    // Parse and validate the response
    const parsed = parseLLMResponse(completion.content);
    if (!parsed || !parsed.title) {
      return {
        facts: [],
        suggestedCategory: null,
        categoryConfidence: 0,
        modelName: completion.model,
        modelVersion: LLM_EXTRACTOR_VERSION,
        promptTokens: completion.usage.promptTokens,
        completionTokens: completion.usage.completionTokens,
        estimatedCostUsd: this.provider.estimateCost(opts.model, completion.usage),
      };
    }

    // Convert to ExtractedFact[] compatible format
    const facts = convertToExtractedFacts(parsed, url);

    return {
      facts,
      suggestedCategory: parsed.category_path ?? null,
      categoryConfidence: parsed.category_confidence ?? 0.5,
      modelName: completion.model,
      modelVersion: LLM_EXTRACTOR_VERSION,
      promptTokens: completion.usage.promptTokens,
      completionTokens: completion.usage.completionTokens,
      estimatedCostUsd: this.provider.estimateCost(opts.model, completion.usage),
    };
  }

  /**
   * Extract and produce a full ExtractedFactSet matching the
   * field-extractor contract — ready for the semantic mapper.
   */
  async extractFactSet(
    cleanedText: string,
    url: string,
    artifactId: ArtifactId,
    options?: LLMExtractionOptions
  ): Promise<{ factSet: ExtractedFactSet; meta: LLMExtractionResult }> {
    const result = await this.extract(cleanedText, url, artifactId, options);

    const factSet: ExtractedFactSet = {
      artifactId,
      marketplace: "link_url",
      extractorVersion: LLM_EXTRACTOR_VERSION,
      facts: result.facts,
      extractedAt: new Date(),
    };

    return { factSet, meta: result };
  }
}
