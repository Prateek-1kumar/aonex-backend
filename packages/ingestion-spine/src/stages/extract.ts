// Spine stage: extract — dispatch to the lane-specific adapter.extract().
//
// runExtract calls the adapter (which owns all lane complexity: parsers, LLM,
// browser, etc.) and tags the returned ExtractedFactSet with the artifactId.
// Second stage in the orchestrator; pure dispatch plus standard return shape.

import type { IngestionAdapter, IngestionEnvelope } from "../adapter.js";
import type { ArtifactId } from "@aonex/types";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

export interface RunExtractInput {
  adapter: IngestionAdapter;
  envelope: IngestionEnvelope;
  artifactId: ArtifactId;
}

/**
 * Spec §5.2 — second stage. Delegates to the lane-specific adapter.extract().
 * The adapter is responsible for ALL lane-specific complexity (parsers, LLM,
 * browser, etc.). This stage is just dispatch + standard return shape.
 */
export async function runExtract(input: RunExtractInput): Promise<ExtractedFactSet> {
  const factSet = await input.adapter.extract(input.envelope);
  // Tag the fact set with the artifact id (adapter may not know it pre-persistence).
  return { ...factSet, artifactId: input.artifactId };
}
