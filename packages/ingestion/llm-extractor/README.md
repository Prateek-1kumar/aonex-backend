# @aonex/ingestion-llm-extractor

Extracts product fields from cleaned HTML text by calling an OpenAI-compatible LLM, with gap-fill mode for filling only the fields not already covered by structured parsers.

## Exports
- `LLMProductExtractor` — main class; `extract()`, `extractGapFill()`, `extractFactSet()` methods
- `buildExtractionPrompt` — constructs the chat messages for a full or gap-fill extraction
- `parseLLMResponse`, `convertToExtractedFacts` — parse raw LLM JSON into `ExtractedFact[]`
- `pickModel`, `decideTextBudget`, `truncateCenterPreserving` — tier/budget routing helpers
- `compressJsonLd`, `pruneNextData` — token-reduction utilities for structured hints
- `OpenAIProvider`, `IModelProvider`, `LLMExtractionOptions`, `LLMExtractionResult` — provider types

## How it fits
Layer C (LLM gap-fill) in the extraction ladder, invoked by `@aonex/link-adapter`'s `runExtractionLayers` after structured and DOM layers have run. Also used directly by the ingestion worker for full extractions.

## Dependencies
- `@aonex/types`, `@aonex/ingestion-field-extractor`
