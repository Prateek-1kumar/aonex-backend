# @aonex/vision-extractor

Calls a multimodal vision LLM (Groq `llama-3.2-90b-vision-preview`) with a page screenshot to extract product fields that text parsers cannot see (image-rendered prices, size charts, spec graphics).

## Exports
- `callVision(input, deps)` — sends a base64 PNG to the vision LLM; returns `VisionCallResult` with `ExtractedFact[]`
- `shouldEscalateToVision(opts)` — heuristic detector that checks for size-chart images, spec graphics, missing prices, and variant markup; returns `VisionEscalationDecision`
- `VisionCallInput`, `VisionCallResult`, `VisionFetchImpl` — call types
- `VisionEscalationSignal`, `VisionEscalationDecision` — escalation types
- `VISION_EXTRACTOR_VERSION` — version constant for provenance tracking

## How it fits
Layer F (vision tier-3) in `@aonex/link-adapter`'s `runExtractionLayers`, invoked after structured, DOM, and LLM passes when `shouldEscalateToVision` fires and `GROQ_API_KEY` or `OPENAI_API_KEY` is set. Screenshots are taken by `@aonex/ingestion-browser-fallback`.

## Dependencies
- `@aonex/ingestion-field-extractor` (for `ExtractedFact` type)
