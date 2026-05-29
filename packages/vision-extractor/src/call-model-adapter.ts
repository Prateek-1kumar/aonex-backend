// Phase 3 Task 5: adapter that exposes vision-extractor's callVision as a
// `callModel`-shaped function for @aonex/ingestion-llm-extractor's genericExtract.
//
// Vision can't use cleanedText (it needs an image), so this is a FACTORY:
// capture the screenshot + page URL once, then return a function that ignores
// the text argument. The returned function's structural type matches the
// callModel parameter of genericExtract (no import cycle needed).

import { callVision, type VisionCallDeps } from "./vision.js";

export interface CreateVisionCallModelInput {
  screenshotBase64: string;
  pageUrl: string;
  deps: VisionCallDeps;
}

/** Returns a callModel-shaped function that runs vision-extractor against the
 *  captured screenshot. cleanedText is ignored (vision is image-based). */
export function createVisionCallModel(
  input: CreateVisionCallModelInput
): (
  schemaFields: string[],
  _cleanedText: string
) => Promise<Record<string, { value: unknown; rawConfidence: number }>> {
  return async (schemaFields, _cleanedText) => {
    const result = await callVision(
      {
        screenshotBase64: input.screenshotBase64,
        pageUrl: input.pageUrl,
        expectedFields: schemaFields,
      },
      input.deps
    );
    const out: Record<string, { value: unknown; rawConfidence: number }> = {};
    for (const fact of result.facts) {
      out[fact.rawKey] = {
        value: fact.extractedValue,
        rawConfidence: fact.confidence,
      };
    }
    return out;
  };
}
